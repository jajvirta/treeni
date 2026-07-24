#!/usr/bin/env bash
#
# One-time infrastructure bootstrap for the treeni static site.
# Idempotent — safe to re-run. Ensures:
#   1. a private S3 bucket
#   2. a CloudFront Origin Access Control (OAC)
#   3. a CloudFront Function that resolves directory URIs to index.html
#   4. an S3 origin + ordered cache behavior on your EXISTING distribution
#   5. an S3 bucket policy letting that distribution (via OAC) read objects
#
# The existing distribution's DEFAULT behavior is left untouched when
# PATH_PATTERN is set (the app gets its own ordered behavior).
#
# Usage:  aws-vault exec <profile> -- ./bootstrap.sh
#         APPLY=1 aws-vault exec <profile> -- ./bootstrap.sh   # skip prompt
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
[[ -f "$SCRIPT_DIR/deploy.env" ]] && source "$SCRIPT_DIR/deploy.env"

: "${BUCKET:?Set BUCKET in deploy.env}"
: "${REGION:?Set REGION in deploy.env}"
: "${DISTRIBUTION_ID:?Set DISTRIBUTION_ID in deploy.env}"
PATH_PATTERN="${PATH_PATTERN:-}"
FUNCTION_NAME="${FUNCTION_NAME:-treeni-index-rewrite}"

command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

ORIGIN_ID="s3-${BUCKET}"
OAC_NAME="${BUCKET}-oac"
CACHING_OPTIMIZED="658327ea-f89d-4fab-a63d-7e88639e58f6"  # AWS managed policy

# "/treeni/*" -> prefix "treeni"; empty -> root.
PREFIX="${PATH_PATTERN%/\*}"; PREFIX="${PREFIX#/}"
if [[ -n "$PREFIX" ]]; then RESOURCE_ARN="arn:aws:s3:::${BUCKET}/${PREFIX}/*"
else                        RESOURCE_ARN="arn:aws:s3:::${BUCKET}/*"; fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DISTRIBUTION_ID}"
S3_DOMAIN="${BUCKET}.s3.${REGION}.amazonaws.com"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "Account:      $ACCOUNT_ID"
echo "Bucket:       $BUCKET ($REGION)"
echo "Distribution: $DISTRIBUTION_ID"
echo "Origin id:    $ORIGIN_ID"
echo "Path pattern: ${PATH_PATTERN:-<default behavior>}"
echo "S3 prefix:    ${PREFIX:-<root>}"
echo

# ---------- 1. S3 bucket ----------
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "==> Bucket $BUCKET already exists"
else
  echo "==> Creating bucket $BUCKET"
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  fi
fi
echo "==> Enforcing block-public-access on $BUCKET"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

# ---------- 2. Origin Access Control ----------
OAC_ID="$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='${OAC_NAME}'].Id | [0]" --output text 2>/dev/null || true)"
if [[ -z "$OAC_ID" || "$OAC_ID" == "None" ]]; then
  echo "==> Creating Origin Access Control $OAC_NAME"
  OAC_ID="$(aws cloudfront create-origin-access-control \
    --origin-access-control-config \
    "Name=${OAC_NAME},SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
    --query 'OriginAccessControl.Id' --output text)"
else
  echo "==> OAC $OAC_NAME exists ($OAC_ID)"
fi

# ---------- 3. CloudFront Function (directory -> index.html) ----------
if aws cloudfront describe-function --name "$FUNCTION_NAME" >/dev/null 2>&1; then
  echo "==> Updating CloudFront Function $FUNCTION_NAME"
  FN_ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query 'ETag' --output text)"
  aws cloudfront update-function --name "$FUNCTION_NAME" --if-match "$FN_ETAG" \
    --function-config Comment="treeni: resolve directory URIs to index.html",Runtime="cloudfront-js-2.0" \
    --function-code "fileb://$SCRIPT_DIR/infra/index-rewrite.js" >/dev/null
else
  echo "==> Creating CloudFront Function $FUNCTION_NAME"
  aws cloudfront create-function --name "$FUNCTION_NAME" \
    --function-config Comment="treeni: resolve directory URIs to index.html",Runtime="cloudfront-js-2.0" \
    --function-code "fileb://$SCRIPT_DIR/infra/index-rewrite.js" >/dev/null
fi
FN_ETAG="$(aws cloudfront describe-function --name "$FUNCTION_NAME" --query 'ETag' --output text)"
aws cloudfront publish-function --name "$FUNCTION_NAME" --if-match "$FN_ETAG" >/dev/null
FUNC_ARN="$(aws cloudfront describe-function --name "$FUNCTION_NAME" \
  --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)"
echo "    function ARN: $FUNC_ARN"

# ---------- 4. Distribution origin + behavior ----------
echo "==> Fetching distribution config"
aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" > "$TMP/dist.json"
ETAG="$(jq -r '.ETag' "$TMP/dist.json")"
jq '.DistributionConfig' "$TMP/dist.json" > "$TMP/config.json"

ORIGIN_JSON="$(jq -n --arg id "$ORIGIN_ID" --arg domain "$S3_DOMAIN" --arg oac "$OAC_ID" '
  { Id: $id, DomainName: $domain, OriginPath: "",
    CustomHeaders: { Quantity: 0 },
    S3OriginConfig: { OriginAccessIdentity: "" },
    OriginAccessControlId: $oac,
    ConnectionAttempts: 3, ConnectionTimeout: 10,
    OriginShield: { Enabled: false } }')"

BEHAVIOR_JSON="$(jq -n --arg origin "$ORIGIN_ID" --arg fn "$FUNC_ARN" --arg cp "$CACHING_OPTIMIZED" '
  { TargetOriginId: $origin,
    ViewerProtocolPolicy: "redirect-to-https",
    AllowedMethods: { Quantity: 2, Items: ["GET","HEAD"],
      CachedMethods: { Quantity: 2, Items: ["GET","HEAD"] } },
    Compress: true,
    CachePolicyId: $cp,
    FunctionAssociations: { Quantity: 1, Items: [ { FunctionARN: $fn, EventType: "viewer-request" } ] },
    LambdaFunctionAssociations: { Quantity: 0 },
    FieldLevelEncryptionId: "",
    SmoothStreaming: false }')"

if [[ -n "$PATH_PATTERN" ]]; then
  jq --argjson origin "$ORIGIN_JSON" --argjson behavior "$BEHAVIOR_JSON" \
     --arg pattern "$PATH_PATTERN" --arg originId "$ORIGIN_ID" '
    .Origins.Items |= (if any(.Id == $originId) then . else . + [$origin] end)
    | .Origins.Quantity = (.Origins.Items | length)
    | .CacheBehaviors = (.CacheBehaviors // { Quantity: 0, Items: [] })
    | .CacheBehaviors.Items = (.CacheBehaviors.Items // [])
    | .CacheBehaviors.Items |=
        (if any(.PathPattern == $pattern) then .
         else . + [ ($behavior + { PathPattern: $pattern }) ] end)
    | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)
  ' "$TMP/config.json" > "$TMP/config-new.json"
else
  jq --argjson origin "$ORIGIN_JSON" --argjson behavior "$BEHAVIOR_JSON" --arg originId "$ORIGIN_ID" '
    .Origins.Items |= (if any(.Id == $originId) then . else . + [$origin] end)
    | .Origins.Quantity = (.Origins.Items | length)
    | .DefaultCacheBehavior = $behavior
  ' "$TMP/config.json" > "$TMP/config-new.json"
fi

echo "==> Planned change to distribution $DISTRIBUTION_ID:"
echo "    + origin '$ORIGIN_ID' -> $S3_DOMAIN (OAC $OAC_ID)"
if [[ -n "$PATH_PATTERN" ]]; then
  echo "    + ordered behavior '$PATH_PATTERN' -> '$ORIGIN_ID' (function: $FUNCTION_NAME)"
else
  echo "    ! OVERWRITE default behavior -> '$ORIGIN_ID'"
fi

if [[ "${APPLY:-}" != "1" ]]; then
  read -r -p "Apply to distribution $DISTRIBUTION_ID? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "Aborted (set APPLY=1 to skip this prompt)."; exit 1; }
fi

echo "==> Updating distribution"
aws cloudfront update-distribution --id "$DISTRIBUTION_ID" --if-match "$ETAG" \
  --distribution-config "file://$TMP/config-new.json" >/dev/null

# ---------- 5. Bucket policy ----------
echo "==> Setting bucket policy (CloudFront OAC read access)"
POLICY="$(jq -n --arg res "$RESOURCE_ARN" --arg arn "$DIST_ARN" '
  { Version: "2012-10-17",
    Statement: [ { Sid: "AllowCloudFrontOAC", Effect: "Allow",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: "s3:GetObject", Resource: $res,
      Condition: { StringEquals: { "AWS:SourceArn": $arn } } } ] }')"
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$POLICY"

echo
echo "==> Bootstrap complete."
echo "    Deploy the files with:  aws-vault exec <profile> -- ./deploy.sh"
echo "    (CloudFront changes can take a few minutes to propagate.)"
