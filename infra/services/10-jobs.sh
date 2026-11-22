#!/usr/bin/env bash
# [Marwan] Jobs + Analytics + Auth service
#   DynamoDB AtsUsers (+ email-index) | Neon Postgres (jobs, departments, analytics)
#   IAM role ats-jobs-role | Lambda ats-jobs-service
source "$(dirname "$0")/../lib.sh"
step "Jobs service (Marwan)"
create_table AtsUsers "AttributeName=userId,AttributeType=S AttributeName=email,AttributeType=S" \
  "AttributeName=userId,KeyType=HASH" \
  '[{"IndexName":"email-index","KeySchema":[{"AttributeName":"email","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}]'

echo "  migrating jobs database schema"
(cd "$ROOT_DIR/services/jobs-service" && npm install --no-audit --no-fund --loglevel=error >/dev/null)
node "$ROOT_DIR/scripts/migrate-jobs-db.js" || exit 1

create_role "$ROLE_JOBS" "$INFRA_DIR/iam/jobs-policy.json"
ENV="{\"Variables\":{\"NODE_ENV\":\"production\",\"SERVICE_NAME\":\"jobs-service\",\"USERS_TABLE\":\"AtsUsers\",\"CORS_ORIGINS\":\"$WEB_ORIGIN\",\"CANDIDATES_FUNCTION\":\"$FN_CANDIDATES\",\"PIPELINE_FUNCTION\":\"$FN_PIPELINE\"}}"
deploy_function "$FN_JOBS" "$ROLE_JOBS" jobs-service src/lambda.handler "$ENV" 512 20
