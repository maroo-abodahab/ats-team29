#!/usr/bin/env bash
# Shared settings for every infra script. Source it:  source "$(dirname "$0")/lib.sh"
#   TARGET=floci (default)  -> local AWS emulator at http://localhost:4566
#   TARGET=aws              -> your real AWS account (credentials from ~/.aws, never from this repo)
set -uo pipefail
export AWS_PAGER="" MSYS_NO_PATHCONV=1
export PATH="$PATH:/c/Program Files/Amazon/AWSCLIV2"

# Windows-style paths (C:/Users/...) when running in Git Bash, so node and the AWS CLI
# understand them even with MSYS_NO_PATHCONV=1; plain paths on Linux/macOS.
winpwd() { pwd -W 2>/dev/null || pwd; }
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && winpwd)"
ROOT_DIR="$(cd "$INFRA_DIR/.." && winpwd)"
TARGET="${TARGET:-floci}"
REGION="us-east-1"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

if [ "$TARGET" = "aws" ]; then
  unset AWS_PROFILE
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || { echo "No AWS credentials found (aws configure)."; exit 1; }
  [ "$ACCOUNT" = "000000000000" ] && { echo "That is Floci, not real AWS. Run: unset AWS_PROFILE"; exit 1; }
  SUFFIX="${ATS_SUFFIX:?set ATS_SUFFIX=<unique-lowercase-id> for globally unique S3 bucket names}"
else
  export AWS_PROFILE=floci
  ACCOUNT="000000000000"
  SUFFIX="local"
fi

# ---- Resource names (one place, used by every script) ----------------------
WEB_BUCKET="ats-web-$SUFFIX"
CV_BUCKET="ats-cv-bucket-$SUFFIX"
API_NAME="ats-http-api"
FN_JOBS="ats-jobs-service";             ROLE_JOBS="ats-jobs-role"
FN_CANDIDATES="ats-candidates-service"; ROLE_CANDIDATES="ats-candidates-role"
FN_PIPELINE="ats-pipeline-service";     ROLE_PIPELINE="ats-pipeline-role"
FN_NOTIFIER="ats-notifier";             ROLE_NOTIFIER="ats-notifier-role"
QUEUE="ats-application-events";         DLQ="ats-application-events-dlq"
TOPIC="ats-pipeline-notifications";     ALERT_TOPIC="ats-security-alerts"
SECRET_AUTH="ats/auth"; SECRET_JOBS_DB="ats/jobs-db"; SECRET_EMAIL="ats/email"
RUNTIME="nodejs22.x"

if [ "$TARGET" = "aws" ]; then
  WEB_ORIGIN="http://$WEB_BUCKET.s3-website-$REGION.amazonaws.com"
  S3_PUBLIC_ENDPOINT=""
else
  WEB_ORIGIN="http://localhost:4566"
  S3_PUBLIC_ENDPOINT="http://localhost:4566"
fi
TOPIC_ARN="arn:aws:sns:$REGION:$ACCOUNT:$TOPIC"
ALERT_TOPIC_ARN="arn:aws:sns:$REGION:$ACCOUNT:$ALERT_TOPIC"

SECRETS_FILE="$INFRA_DIR/.secrets.local"
TMP_DIR="$ROOT_DIR/out/.infra"; mkdir -p "$TMP_DIR"

step() { echo; echo "=== $* ==="; }
ok()   { "$@" >/dev/null 2>&1 || true; }   # run, ignore "already exists" style errors

# Replace ${ACCOUNT} ${REGION} ${CV_BUCKET} ... in a policy template -> file path
render_policy() {
  local src="$1" out="$TMP_DIR/$(basename "$1")"
  sed -e "s/\${ACCOUNT}/$ACCOUNT/g" -e "s/\${REGION}/$REGION/g" -e "s/\${CV_BUCKET}/$CV_BUCKET/g" \
      -e "s/\${WEB_BUCKET}/$WEB_BUCKET/g" "$src" > "$out"
  echo "$out"
}

create_table() { # name, attribute definitions, key schema, [GSI json]
  local name="$1" attrs="$2" keys="$3" gsi="${4:-}"
  if aws dynamodb describe-table --table-name "$name" >/dev/null 2>&1; then echo "  table $name exists"; return; fi
  if [ -n "$gsi" ]; then
    aws dynamodb create-table --table-name "$name" --attribute-definitions $attrs --key-schema $keys \
      --global-secondary-indexes "$gsi" --billing-mode PAY_PER_REQUEST \
      --sse-specification Enabled=true >/dev/null
  else
    aws dynamodb create-table --table-name "$name" --attribute-definitions $attrs --key-schema $keys \
      --billing-mode PAY_PER_REQUEST --sse-specification Enabled=true >/dev/null
  fi
  aws dynamodb wait table-exists --table-name "$name"
  # Point-in-time recovery: restore the table to any second in the last 35 days
  ok aws dynamodb update-continuous-backups --table-name "$name" --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
  echo "  table $name created (on-demand, encrypted, PITR)"
}

create_role() { # role name, policy template file
  local role="$1" policy_file
  policy_file="$(render_policy "$2")"
  if ! aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    aws iam create-role --role-name "$role" --assume-role-policy-document "file://$INFRA_DIR/iam/lambda-trust-policy.json" >/dev/null
    NEW_ROLE=1
  fi
  aws iam put-role-policy --role-name "$role" --policy-name "$role-least-privilege" --policy-document "file://$policy_file"
  echo "  role $role (least-privilege inline policy)"
}

# Create or update a Lambda function from dist/<service>.zip
deploy_function() { # function name, role, service folder, handler, env-json, memory, timeout
  local fn="$1" role="$2" service="$3" handler="$4" env="$5" memory="${6:-256}" timeout="${7:-15}"
  (cd "$ROOT_DIR/services/$service" && npm install --no-audit --no-fund --loglevel=error >/dev/null && node "$ROOT_DIR/scripts/build-lambda.js" "$service") || exit 1
  local zip="$ROOT_DIR/dist/$service.zip"
  if aws lambda get-function --function-name "$fn" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$zip" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$fn"
    aws lambda update-function-configuration --function-name "$fn" --handler "$handler" --memory-size "$memory" \
      --timeout "$timeout" --environment "$env" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$fn"
    echo "  function $fn updated"
  else
    [ "${NEW_ROLE:-0}" = 1 ] && [ "$TARGET" = "aws" ] && { echo "  waiting 10 s for the new IAM role"; sleep 10; }
    aws lambda create-function --function-name "$fn" --runtime "$RUNTIME" --handler "$handler" \
      --role "arn:aws:iam::$ACCOUNT:role/$role" --zip-file "fileb://$zip" --memory-size "$memory" \
      --timeout "$timeout" --environment "$env" >/dev/null
    aws lambda wait function-active-v2 --function-name "$fn"
    echo "  function $fn created"
  fi
  ok aws logs create-log-group --log-group-name "/aws/lambda/$fn"
  ok aws logs put-retention-policy --log-group-name "/aws/lambda/$fn" --retention-in-days 14
}

secret_value() { aws secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text 2>/dev/null; }

put_secret() { # name, json
  if aws secretsmanager describe-secret --secret-id "$1" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$1" --secret-string "$2" >/dev/null
  else
    aws secretsmanager create-secret --name "$1" --secret-string "$2" >/dev/null
  fi
}

load_local_secrets() { [ -f "$SECRETS_FILE" ] && set -a && . "$SECRETS_FILE" && set +a; return 0; }

api_id() { aws apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text 2>/dev/null; }
api_url() {
  local id; id="$(api_id)"
  [ -z "$id" ] || [ "$id" = "None" ] && return 1
  if [ "$TARGET" = "aws" ]; then echo "https://$id.execute-api.$REGION.amazonaws.com"; else echo "http://$id.execute-api.localhost.floci.io:4566"; fi
}
