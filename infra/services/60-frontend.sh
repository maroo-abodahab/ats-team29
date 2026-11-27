#!/usr/bin/env bash
# [Shared, lead: Laila - cloud deployment] Frontend on S3 static website hosting.
# Writes the API URL into frontend/js/config.js, then uploads the site with the
# right content types. Nothing in the frontend is secret.
source "$(dirname "$0")/../lib.sh"
step "Frontend website (S3)"

API_URL="$(api_url)" || { echo "  API not found: run 50-api-gateway.sh first"; exit 1; }
CONFIG="$ROOT_DIR/frontend/js/config.js"
if [ "$TARGET" = "aws" ]; then
  sed -i "s#^const AWS_API = .*#const AWS_API = '$API_URL';#" "$CONFIG"
else
  sed -i "s#^const FLOCI_API = .*#const FLOCI_API = '$API_URL';#" "$CONFIG"
fi

ok aws s3api create-bucket --bucket "$WEB_BUCKET"
if [ "$TARGET" = "aws" ]; then
  # Public READ of website files only (no write, no list). ACLs stay blocked.
  aws s3api put-public-access-block --bucket "$WEB_BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
  aws s3api put-bucket-policy --bucket "$WEB_BUCKET" --policy "file://$(render_policy "$INFRA_DIR/iam/web-bucket-public-read.json")"
  aws s3 website "s3://$WEB_BUCKET" --index-document index.html --error-document index.html
fi

aws s3 sync "$ROOT_DIR/frontend" "s3://$WEB_BUCKET" --delete --exclude "*" --include "*.html" --content-type "text/html; charset=utf-8" >/dev/null
aws s3 sync "$ROOT_DIR/frontend/css" "s3://$WEB_BUCKET/css" --delete --content-type "text/css; charset=utf-8" >/dev/null
aws s3 sync "$ROOT_DIR/frontend/js" "s3://$WEB_BUCKET/js" --delete --content-type "text/javascript; charset=utf-8" >/dev/null
if [ -d "$ROOT_DIR/frontend/img" ]; then aws s3 sync "$ROOT_DIR/frontend/img" "s3://$WEB_BUCKET/img" --delete >/dev/null; fi

if [ "$TARGET" = "aws" ]; then
  echo "  Website: $WEB_ORIGIN"
else
  echo "  Website: http://localhost:4566/$WEB_BUCKET/index.html"
fi
