#!/usr/bin/env bash
#
# Provision (idempotently) the personal treeni workout backend:
#   1. a DynamoDB table (on-demand) holding sessions
#   2. an IAM role for the Lambda (basic logs + table access)
#   3. a Node 20 Lambda (no bundled deps; AWS SDK from the runtime)
#   4. a public API Gateway HTTP API (Lambda proxy, payload format 2.0) fronting
#      the Lambda — NOT a Lambda Function URL (anonymous URLs are blocked by the
#      AWS Org guardrail, and OAC-signed AWS_IAM URLs can't sign POST
#      bodies/query strings). Access is gated by the X-Origin-Secret header
#      (CloudFront-injected) + the X-Api-Key user secret, checked in the Lambda.
#   5. a custom origin request policy that forwards X-Api-Key + query strings
#      (not Host, so CloudFront sets the API Gateway host)
#   6. on your EXISTING distribution: a custom origin pointing at API Gateway +
#      an ORDERED cache behavior for the API path, inserted BEFORE the app one
#
# Safe to re-run: updates the function code/config, and only mutates the
# distribution when the origin (incl. its OAC) or behavior are missing.
#
# Usage:  aws-vault exec <profile> -- ./infra/backend.sh
#         APPLY=1 aws-vault exec <profile> -- ./infra/backend.sh   # skip prompt
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
[[ -f "$SCRIPT_DIR/deploy.env" ]] && source "$SCRIPT_DIR/deploy.env"

: "${REGION:?Set REGION in deploy.env}"
: "${DISTRIBUTION_ID:?Set DISTRIBUTION_ID in deploy.env}"
: "${API_TOKEN:?Set API_TOKEN in deploy.env (the bearer secret to paste into the app)}"
PATH_PATTERN="${PATH_PATTERN:-}"
ORIGIN_SECRET="${ORIGIN_SECRET:-}"
TABLE_NAME="${TABLE_NAME:-treeni}"
LAMBDA_NAME="${LAMBDA_NAME:-treeni-api}"
LAMBDA_ROLE="${LAMBDA_ROLE:-treeni-api-role}"

command -v jq  >/dev/null || { echo "jq is required";  exit 1; }
command -v zip >/dev/null || { echo "zip is required"; exit 1; }

# API path mirrors the app prefix: "/treeni/*" -> "/treeni/api/*"; empty -> "/api/*"
PREFIX="${PATH_PATTERN%/\*}"; PREFIX="${PREFIX#/}"
if [[ -n "$PREFIX" ]]; then API_PATTERN="/${PREFIX}/api/*"; else API_PATTERN="/api/*"; fi

ORIGIN_ID="lambda-${LAMBDA_NAME}"   # CloudFront origin id (now points at API Gateway)
API_NAME="${API_NAME:-${LAMBDA_NAME}-http}"
ORP_NAME="${LAMBDA_NAME}-orp"
CACHING_DISABLED="4135ea2d-6df8-44a3-9df3-4b5a84be39ad"           # AWS managed

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TABLE_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE_NAME}"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${LAMBDA_ROLE}"
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DISTRIBUTION_ID}"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [[ -n "$ORIGIN_SECRET" ]]; then GUARD_DESC="X-Origin-Secret enabled"; else GUARD_DESC="NONE — set ORIGIN_SECRET (API Gateway is public; this gates it)"; fi
echo "Account:      $ACCOUNT_ID"
echo "Region:       $REGION"
echo "Distribution: $DISTRIBUTION_ID"
echo "Table:        $TABLE_NAME"
echo "Lambda:       $LAMBDA_NAME (role $LAMBDA_ROLE)"
echo "API path:     $API_PATTERN"
echo "Auth model:   CloudFront -> API Gateway (public), gated by X-Origin-Secret + X-Api-Key"
echo "Origin guard: $GUARD_DESC"
echo

# ---------- 1. DynamoDB table ----------
if aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Table $TABLE_NAME already exists"
else
  echo "==> Creating DynamoDB table $TABLE_NAME (on-demand)"
  aws dynamodb create-table --table-name "$TABLE_NAME" --region "$REGION" \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$REGION"
fi

# ---------- 2. IAM role ----------
if aws iam get-role --role-name "$LAMBDA_ROLE" >/dev/null 2>&1; then
  echo "==> Role $LAMBDA_ROLE already exists"
else
  echo "==> Creating role $LAMBDA_ROLE"
  TRUST="$(jq -n '{Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:"lambda.amazonaws.com"},Action:"sts:AssumeRole"}]}')"
  aws iam create-role --role-name "$LAMBDA_ROLE" \
    --assume-role-policy-document "$TRUST" >/dev/null
  aws iam attach-role-policy --role-name "$LAMBDA_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
  echo "    waiting for role to propagate…"; sleep 10
fi
echo "==> Putting inline DynamoDB policy on $LAMBDA_ROLE"
DDB_POLICY="$(jq -n --arg arn "$TABLE_ARN" '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["dynamodb:Query","dynamodb:GetItem","dynamodb:PutItem","dynamodb:DeleteItem"],Resource:$arn}]}')"
aws iam put-role-policy --role-name "$LAMBDA_ROLE" \
  --policy-name treeni-ddb --policy-document "$DDB_POLICY" >/dev/null

# ---------- 3. Lambda function ----------
echo "==> Packaging function"
( cd "$SCRIPT_DIR/infra/lambda" && zip -q "$TMP/fn.zip" index.mjs )
# Build the env as JSON (the Variables={k=v,…} shorthand can't express an empty
# value, which breaks when ORIGIN_SECRET is blank). Omit ORIGIN_SECRET entirely
# when empty so the handler's guard is simply disabled.
ENV_VARS="$(jq -n --arg t "$TABLE_NAME" --arg k "$API_TOKEN" --arg o "$ORIGIN_SECRET" \
  '{Variables: ({TABLE_NAME:$t, API_TOKEN:$k} + (if $o=="" then {} else {ORIGIN_SECRET:$o} end))}')"

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating function code + config"
  aws lambda update-function-code --function-name "$LAMBDA_NAME" --region "$REGION" \
    --zip-file "fileb://$TMP/fn.zip" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$LAMBDA_NAME" --region "$REGION"
  aws lambda update-function-configuration --function-name "$LAMBDA_NAME" --region "$REGION" \
    --runtime nodejs20.x --handler index.handler --timeout 10 --memory-size 128 \
    --environment "$ENV_VARS" >/dev/null
else
  echo "==> Creating function $LAMBDA_NAME"
  aws lambda create-function --function-name "$LAMBDA_NAME" --region "$REGION" \
    --runtime nodejs20.x --handler index.handler --role "$ROLE_ARN" \
    --timeout 10 --memory-size 128 --environment "$ENV_VARS" \
    --zip-file "fileb://$TMP/fn.zip" >/dev/null
fi
aws lambda wait function-active-v2 --function-name "$LAMBDA_NAME" --region "$REGION"

# ---------- 4. API Gateway HTTP API + origin request policy ----------
# A public HTTP API (payload format 2.0 — the same event shape the handler
# already uses) fronts the Lambda. We deliberately do NOT use a Lambda Function
# URL: anonymous (auth NONE) URLs are blocked by the AWS Org guardrail, and the
# OAC-signed (AWS_IAM) alternative can't sign POST bodies/query strings.
# CloudFront reaches the API over HTTPS; access is gated by the X-Origin-Secret
# header (only CloudFront sends it) + the X-Api-Key user secret, both checked in
# the Lambda — so set ORIGIN_SECRET in deploy.env (it is load-bearing now).
LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null || true)"
if [[ -z "$API_ID" || "$API_ID" == "None" ]]; then
  echo "==> Creating HTTP API $API_NAME (Lambda proxy, \$default route + auto-deploy stage)"
  API_ID="$(aws apigatewayv2 create-api --region "$REGION" --name "$API_NAME" \
    --protocol-type HTTP --target "$LAMBDA_ARN" --query ApiId --output text)"
  # quick-create also wires the AWS_PROXY integration (payload 2.0), the
  # $default route + auto-deploy $default stage, and an invoke permission.
else
  echo "==> HTTP API $API_NAME exists ($API_ID)"
fi
# Ensure the invoke permission (idempotent; harmless if quick-create added one).
aws lambda add-permission --function-name "$LAMBDA_NAME" --region "$REGION" \
  --statement-id ApiGatewayInvoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" >/dev/null 2>&1 || true
API_HOST="${API_ID}.execute-api.${REGION}.amazonaws.com"
echo "    API host: $API_HOST"

# Origin request policy: forward X-Api-Key + all query strings, but NOT Host (so
# CloudFront sets Host to the API Gateway domain, which API Gateway requires).
ORP_ID="$(aws cloudfront list-origin-request-policies --type custom \
  --query "OriginRequestPolicyList.Items[?OriginRequestPolicy.OriginRequestPolicyConfig.Name=='${ORP_NAME}'].OriginRequestPolicy.Id | [0]" \
  --output text 2>/dev/null || true)"
if [[ -z "$ORP_ID" || "$ORP_ID" == "None" ]]; then
  echo "==> Creating origin request policy $ORP_NAME (X-Api-Key + query strings)"
  ORP_CFG="$(jq -n --arg name "$ORP_NAME" '
    { Name:$name, Comment:"forward X-Api-Key + query strings, not Host",
      HeadersConfig:{ HeaderBehavior:"whitelist", Headers:{ Quantity:1, Items:["x-api-key"] } },
      CookiesConfig:{ CookieBehavior:"none" },
      QueryStringsConfig:{ QueryStringBehavior:"all" } }')"
  ORP_ID="$(aws cloudfront create-origin-request-policy \
    --origin-request-policy-config "$ORP_CFG" \
    --query 'OriginRequestPolicy.Id' --output text)"
else
  echo "==> Origin request policy $ORP_NAME exists ($ORP_ID)"
fi

# ---------- 5. CloudFront origin + ordered behavior ----------
echo "==> Fetching distribution config"
aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" > "$TMP/dist.json"
ETAG="$(jq -r '.ETag' "$TMP/dist.json")"
jq '.DistributionConfig' "$TMP/dist.json" > "$TMP/config.json"

ORIGIN_DOMAIN="$(jq -r --arg id "$ORIGIN_ID" '(.Origins.Items[] | select(.Id==$id) | .DomainName) // ""' "$TMP/config.json")"
ORIGIN_OAC="$(jq -r --arg id "$ORIGIN_ID" '(.Origins.Items[] | select(.Id==$id) | .OriginAccessControlId) // ""' "$TMP/config.json")"
HAVE_BEHAVIOR="$(jq --arg p "$API_PATTERN" '((.CacheBehaviors.Items // [])[] | select(.PathPattern == $p)) // empty | true' "$TMP/config.json")"
BEHAVIOR_ORP="$(jq -r --arg p "$API_PATTERN" '((.CacheBehaviors.Items // [])[] | select(.PathPattern == $p) | .OriginRequestPolicyId) // ""' "$TMP/config.json")"
LIVE_ORIGIN_SECRET="$(jq -r --arg id "$ORIGIN_ID" '(.Origins.Items[] | select(.Id==$id) | (.CustomHeaders.Items[]? | select(.HeaderName=="X-Origin-Secret") | .HeaderValue)) // ""' "$TMP/config.json")"

if [[ "$ORIGIN_DOMAIN" == "$API_HOST" && -z "$ORIGIN_OAC" && "$HAVE_BEHAVIOR" == "true" && "$BEHAVIOR_ORP" == "$ORP_ID" && "$LIVE_ORIGIN_SECRET" == "$ORIGIN_SECRET" ]]; then
  echo "==> Distribution already points the API origin at API Gateway with the right policy — nothing to change."
else
  if [[ -n "$ORIGIN_SECRET" ]]; then
    CUSTOM_HEADERS="$(jq -n --arg v "$ORIGIN_SECRET" '{Quantity:1,Items:[{HeaderName:"X-Origin-Secret",HeaderValue:$v}]}')"
  else
    CUSTOM_HEADERS='{"Quantity":0}'
  fi
  ORIGIN_JSON="$(jq -n --arg id "$ORIGIN_ID" --arg domain "$API_HOST" --argjson ch "$CUSTOM_HEADERS" '
    { Id:$id, DomainName:$domain, OriginPath:"",
      CustomHeaders:$ch,
      CustomOriginConfig:{ HTTPPort:80, HTTPSPort:443, OriginProtocolPolicy:"https-only",
        OriginSslProtocols:{Quantity:1,Items:["TLSv1.2"]},
        OriginReadTimeout:30, OriginKeepaliveTimeout:5 },
      ConnectionAttempts:3, ConnectionTimeout:10,
      OriginShield:{Enabled:false} }')"
  BEHAVIOR_JSON="$(jq -n --arg origin "$ORIGIN_ID" --arg pattern "$API_PATTERN" \
      --arg cp "$CACHING_DISABLED" --arg orp "$ORP_ID" '
    { PathPattern:$pattern, TargetOriginId:$origin,
      ViewerProtocolPolicy:"redirect-to-https",
      AllowedMethods:{ Quantity:7, Items:["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
        CachedMethods:{ Quantity:2, Items:["GET","HEAD"] } },
      Compress:true,
      CachePolicyId:$cp,
      OriginRequestPolicyId:$orp,
      FunctionAssociations:{Quantity:0},
      LambdaFunctionAssociations:{Quantity:0},
      FieldLevelEncryptionId:"", SmoothStreaming:false }')"

  # Replace the origin wholesale if it exists (drops any old OAC / Function-URL
  # domain), else add it; put the API behavior FIRST so it out-ranks /<prefix>/*.
  jq --argjson origin "$ORIGIN_JSON" --argjson behavior "$BEHAVIOR_JSON" \
     --arg originId "$ORIGIN_ID" --arg pattern "$API_PATTERN" '
    .Origins.Items |= (if any(.Id == $originId)
                       then map(if .Id == $originId then $origin else . end)
                       else . + [$origin] end)
    | .Origins.Quantity = (.Origins.Items | length)
    | .CacheBehaviors = (.CacheBehaviors // {Quantity:0, Items:[]})
    | .CacheBehaviors.Items = ([ $behavior ] + ((.CacheBehaviors.Items // []) | map(select(.PathPattern != $pattern))))
    | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)
  ' "$TMP/config.json" > "$TMP/config-new.json"

  echo "==> Planned change to distribution $DISTRIBUTION_ID:"
  echo "    + origin '$ORIGIN_ID' -> $API_HOST (https-only, API Gateway, no OAC)"
  echo "    + ordered behavior '$API_PATTERN' -> '$ORIGIN_ID' (CachingDisabled, first in precedence)"

  if [[ "${APPLY:-}" != "1" ]]; then
    read -r -p "Apply to distribution $DISTRIBUTION_ID? [y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted (set APPLY=1 to skip)."; exit 1; }
  fi
  echo "==> Updating distribution"
  aws cloudfront update-distribution --id "$DISTRIBUTION_ID" --if-match "$ETAG" \
    --distribution-config "file://$TMP/config-new.json" >/dev/null
fi

echo
echo "==> Backend ready."
echo "    API base (through CloudFront):  https://<your-domain>${API_PATTERN%\*}"
echo "    Open the app, go to the Log tab, paste your API_TOKEN once."
echo "    (CloudFront changes can take a few minutes to propagate.)"
