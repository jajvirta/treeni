#!/usr/bin/env bash
#
# Diagnose the power-scoring backend (CloudFront -> API Gateway HTTP API -> Lambda).
# Pinpoints where a failure is: API Gateway/integration, the Lambda guard
# (X-Origin-Secret) or user secret (X-Api-Key), or CloudFront routing.
#
# Auth model (no OAC/SigV4):
#   - API Gateway is public; CloudFront injects X-Origin-Secret (only it knows
#     it) and the Lambda rejects requests without it -> blocks direct API hits.
#   - The user secret travels in X-Api-Key.
#
# Read-only against AWS config; the LIVE section makes GETs plus one self-cleaning
# POST. Reads config from deploy.env. Secrets are masked.
#
# Usage:  aws-vault exec <profile> -- ./infra/diagnose-backend.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
[[ -f "$SCRIPT_DIR/deploy.env" ]] && source "$SCRIPT_DIR/deploy.env"

REGION="${REGION:?set REGION in deploy.env}"
DISTRIBUTION_ID="${DISTRIBUTION_ID:?set DISTRIBUTION_ID in deploy.env}"
API_TOKEN="${API_TOKEN:?set API_TOKEN in deploy.env}"
ORIGIN_SECRET="${ORIGIN_SECRET:-}"
LAMBDA_NAME="${LAMBDA_NAME:-treeni-api}"
API_NAME="${API_NAME:-${LAMBDA_NAME}-http}"
PATH_PATTERN="${PATH_PATTERN:-}"
ORIGIN_ID="lambda-${LAMBDA_NAME}"
PREFIX="${PATH_PATTERN%/\*}"; PREFIX="${PREFIX#/}"

command -v jq   >/dev/null || { echo "jq is required";   exit 1; }
command -v curl >/dev/null || { echo "curl is required"; exit 1; }

mask() { local s="$1" n=${#1}; (( n<=8 )) && printf '****(len %d)' "$n" || printf '%s…%s(len %d)' "${s:0:4}" "${s: -2}" "$n"; }
hr()   { printf '\n──────── %s ────────\n' "$1"; }
body_of() { sed '$d' <<<"$1"; }
code_of() { tail -n1 <<<"$1"; }

hr "config (from deploy.env)"
echo "region=$REGION  lambda=$LAMBDA_NAME  api=$API_NAME  dist=$DISTRIBUTION_ID  app-prefix=${PREFIX:-<root>}"
echo "API_TOKEN=$(mask "$API_TOKEN")   ORIGIN_SECRET=$([[ -n $ORIGIN_SECRET ]] && mask "$ORIGIN_SECRET" || echo '<EMPTY — guard disabled!>')"

# ---------------------------------------------------------------------------
hr "1. API Gateway HTTP API exists"
API_ID="$(aws apigatewayv2 get-apis --region "$REGION" --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null || true)"
API_HOST=""
if [[ -n "$API_ID" && "$API_ID" != "None" ]]; then
  API_ENDPOINT="$(aws apigatewayv2 get-api --api-id "$API_ID" --region "$REGION" --query ApiEndpoint --output text 2>/dev/null)"
  API_HOST="${API_ENDPOINT#https://}"
  echo "ApiId=$API_ID"; echo "Endpoint=$API_ENDPOINT"
  echo "  PASS API exists"
else
  echo "  FAIL no API named $API_NAME — run ./infra/backend.sh"
fi

# ---------------------------------------------------------------------------
hr "2. Lambda invoke permission for API Gateway"
POL="$(aws lambda get-policy --function-name "$LAMBDA_NAME" --region "$REGION" --query Policy --output text 2>&1)"
if jq -e . <<<"$POL" >/dev/null 2>&1; then
  jq '.Statement[] | {Sid,Effect,Principal,Action}' <<<"$POL"
  if jq -e '.Statement[] | select(.Effect=="Allow" and (.Action|test("InvokeFunction")) and (.Principal.Service=="apigateway.amazonaws.com"))' <<<"$POL" >/dev/null; then
    echo "  PASS apigateway invoke statement present"
  else
    echo "  FAIL no apigateway invoke statement — run ./infra/backend.sh"
  fi
else
  echo "  FAIL no resource policy — run ./infra/backend.sh"
fi

# ---------------------------------------------------------------------------
hr "3. Lambda env — API_TOKEN must match; ORIGIN_SECRET should be set"
ENVV="$(aws lambda get-function-configuration --function-name "$LAMBDA_NAME" --region "$REGION" --query 'Environment.Variables' 2>&1)"
LAMBDA_OS=""
if jq -e . <<<"$ENVV" >/dev/null 2>&1; then
  LAMBDA_OS=$(jq -r '.ORIGIN_SECRET // ""' <<<"$ENVV")
  LAMBDA_TOK=$(jq -r '.API_TOKEN // ""' <<<"$ENVV")
  echo "TABLE_NAME=$(jq -r '.TABLE_NAME // "<unset>"' <<<"$ENVV")"
  echo "API_TOKEN(lambda)=$([[ -n $LAMBDA_TOK ]] && mask "$LAMBDA_TOK" || echo '<unset>')"
  echo "ORIGIN_SECRET(lambda)=$([[ -n $LAMBDA_OS ]] && mask "$LAMBDA_OS" || echo '<empty — guard off>')"
  [[ "$LAMBDA_TOK" == "$API_TOKEN" ]] && echo "  PASS user secret matches" || echo "  WARN API_TOKEN in deploy.env != Lambda (would be 401)"
else
  echo "  FAIL — cannot read function configuration:"; echo "$ENVV"
fi

# ---------------------------------------------------------------------------
hr "4. CloudFront origin points at API Gateway (no OAC) + X-Origin-Secret"
CFG="$(aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" 2>/dev/null)"
O_DOMAIN="$(jq -r --arg id "$ORIGIN_ID" '.DistributionConfig.Origins.Items[] | select(.Id==$id) | .DomainName // ""' <<<"$CFG")"
O_OAC="$(jq -r --arg id "$ORIGIN_ID" '.DistributionConfig.Origins.Items[] | select(.Id==$id) | .OriginAccessControlId // ""' <<<"$CFG")"
O_SECRET="$(jq -r --arg id "$ORIGIN_ID" '.DistributionConfig.Origins.Items[] | select(.Id==$id) | (.CustomHeaders.Items[]? | select(.HeaderName=="X-Origin-Secret") | .HeaderValue) // ""' <<<"$CFG")"
echo "origin DomainName=$O_DOMAIN"
[[ -n "$API_HOST" && "$O_DOMAIN" == "$API_HOST" ]] && echo "  PASS origin points at API Gateway" || echo "  FAIL origin domain != API Gateway host ($API_HOST) — run ./infra/backend.sh"
[[ -z "$O_OAC" ]] && echo "  PASS no OAC on origin" || echo "  FAIL origin still has an OAC ($O_OAC) — run ./infra/backend.sh"
if [[ "$O_SECRET" == "$ORIGIN_SECRET" && "$O_SECRET" == "$LAMBDA_OS" ]]; then echo "  PASS X-Origin-Secret matches everywhere"
else echo "  FAIL X-Origin-Secret mismatch (cloudfront=$([[ -n $O_SECRET ]] && mask "$O_SECRET" || echo none), lambda=$([[ -n $LAMBDA_OS ]] && mask "$LAMBDA_OS" || echo none), deploy.env=$([[ -n $ORIGIN_SECRET ]] && mask "$ORIGIN_SECRET" || echo none))"; fi

# ---------------------------------------------------------------------------
hr "5. CloudFront behaviors — '/${PREFIX:+$PREFIX/}api/*' first, allows POST, custom ORP"
jq '.DistributionConfig.CacheBehaviors.Items | map({PathPattern,TargetOriginId,methods:.AllowedMethods.Items,OriginRequestPolicyId})' <<<"$CFG"

# ---------------------------------------------------------------------------
hr "6. LIVE — direct to API Gateway (isolates API Gateway+Lambda from CloudFront)"
if [[ -n "$API_HOST" ]]; then
  AURL="https://${API_HOST}/sessions"
  echo "-- direct, NO X-Origin-Secret: the Lambda guard should reject it --"
  R=$(curl -s -m 15 -w $'\n%{http_code}' "$AURL" -H "X-Api-Key: $API_TOKEN")
  echo "GET $AURL -> HTTP $(code_of "$R")"; echo "$(body_of "$R")"
  if [[ -n "$ORIGIN_SECRET" ]]; then
    grep -qi 'forbidden' <<<"$R" && echo "  EXPECTED — guard blocks direct access (no X-Origin-Secret)." || echo "  WARN — expected a 403 forbidden from the guard."
  else echo "  (ORIGIN_SECRET empty so the guard is off — set it!)"; fi
  echo
  echo "-- direct, WITH X-Origin-Secret + X-Api-Key: API Gateway -> Lambda path --"
  R=$(curl -s -m 15 -w $'\n%{http_code}' "$AURL" -H "X-Api-Key: $API_TOKEN" ${ORIGIN_SECRET:+-H "X-Origin-Secret: $ORIGIN_SECRET"})
  echo "GET $AURL -> HTTP $(code_of "$R")"; echo "$(body_of "$R")"
  [[ "$(code_of "$R")" == 200 ]] && echo "  PASS API Gateway -> Lambda works directly." || echo "  >> API Gateway/Lambda problem (not CloudFront) — see body."
else echo "  (skipped: no API)"; fi

# ---------------------------------------------------------------------------
hr "7. LIVE — through CloudFront (the real test)"
CF_DOMAIN="$(aws cloudfront get-distribution --id "$DISTRIBUTION_ID" --query 'Distribution.DomainName' --output text 2>/dev/null)"
if [[ -n "$CF_DOMAIN" && "$CF_DOMAIN" != "None" ]]; then
  CFURL="https://${CF_DOMAIN}/${PREFIX:+$PREFIX/}api/sessions"
  echo "-- GET (list) --"
  R=$(curl -s -m 20 -w $'\n%{http_code}' "$CFURL" -H "X-Api-Key: $API_TOKEN")
  echo "GET $CFURL -> HTTP $(code_of "$R")"; echo "$(body_of "$R")"
  echo
  echo "-- POST (create, then delete) --"
  BODY='{"date":"2000-01-01","entries":[{"exerciseId":"diag","sets":[{"weight":1,"reps":1}]}],"notes":"diagnostic-delete-me"}'
  R=$(curl -s -m 20 -w $'\n%{http_code}' -X POST "$CFURL" -H "X-Api-Key: $API_TOKEN" -H "content-type: application/json" -d "$BODY")
  C=$(code_of "$R"); B=$(body_of "$R")
  echo "POST $CFURL (workout body) -> HTTP $C"; echo "$B"
  case "$C" in
    201) echo "  PASS end-to-end works."
         ID=$(jq -r '.session.id // empty' <<<"$B" 2>/dev/null)
         [[ -n "$ID" ]] && curl -s -m 15 -o /dev/null -X DELETE "${CFURL}/$ID" -H "X-Api-Key: $API_TOKEN" \
            && echo "  (cleaned up diagnostic row $ID)" ;;
    403) grep -qi 'forbidden' <<<"$B" && echo "  >> X-Origin-Secret mismatch between CloudFront and Lambda (section 4)." \
                                       || echo "  >> 403 — see body / section 5 (routing)." ;;
    401) echo "  >> user secret mismatch — X-Api-Key != Lambda API_TOKEN (section 3)." ;;
    5*)  echo "  >> 5xx from the origin — likely the behavior isn't routed to API Gateway, or the integration is broken (sections 4/5)." ;;
    *)   echo "  >> see body above." ;;
  esac
else echo "  FAIL — cannot read distribution domain name."; fi

echo; echo "Summary: section 6 (WITH secret) = 200 proves API Gateway+Lambda; section 7 POST = 201 proves the whole path."
