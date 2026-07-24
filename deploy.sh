#!/usr/bin/env bash
#
# Deploy the static site: sync public/ to S3 and invalidate CloudFront.
#
# Usage:  aws-vault exec <profile> -- ./deploy.sh
#
# Config comes from ./deploy.env (gitignored) or the environment:
#   BUCKET, DISTRIBUTION_ID, PATH_PATTERN (optional)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
[[ -f "$SCRIPT_DIR/deploy.env" ]] && source "$SCRIPT_DIR/deploy.env"

: "${BUCKET:?Set BUCKET in deploy.env or the environment}"
: "${DISTRIBUTION_ID:?Set DISTRIBUTION_ID in deploy.env or the environment}"
PATH_PATTERN="${PATH_PATTERN:-}"
PUBLIC_DIR="$SCRIPT_DIR/public"

# "/treeni/*" -> prefix "treeni"; empty pattern -> bucket root.
PREFIX="${PATH_PATTERN%/\*}"; PREFIX="${PREFIX#/}"
DEST="s3://$BUCKET";  [[ -n "$PREFIX" ]] && DEST="s3://$BUCKET/$PREFIX"
INV_PATH="/*";        [[ -n "$PREFIX" ]] && INV_PATH="/$PREFIX/*"

echo "==> Syncing $PUBLIC_DIR -> $DEST"
# Assets keep a short browser TTL; CloudFront invalidation below guarantees
# the edge serves fresh content immediately after each deploy.
aws s3 sync "$PUBLIC_DIR" "$DEST" --delete --cache-control "public, max-age=300"

echo "==> Re-uploading index.html with no-cache (deploys show immediately)"
aws s3 cp "$PUBLIC_DIR/index.html" "$DEST/index.html" \
  --cache-control "no-cache" \
  --content-type "text/html; charset=utf-8"

echo "==> Invalidating CloudFront $DISTRIBUTION_ID ($INV_PATH)"
INV_ID="$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "$INV_PATH" \
  --query 'Invalidation.Id' --output text)"

echo "==> Done. Invalidation: $INV_ID"
