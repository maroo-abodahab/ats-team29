#!/usr/bin/env bash
# [Shared, lead: Marwan] API Gateway HTTP API "ats-http-api": ONE public entry point
# that routes each path prefix to the Lambda that owns it. /api/internal/* is
# deliberately NOT routed, so internal service endpoints are unreachable from outside.
source "$(dirname "$0")/../lib.sh"
step "API Gateway"

API_ID="$(api_id)"
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID=$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --query ApiId --output text)
  echo "  created API $API_ID"
else
  echo "  reusing API $API_ID"
fi

integration_for() { # function name -> integration id (created once)
  local fn="$1" uri="arn:aws:lambda:$REGION:$ACCOUNT:function:$1" id
  id=$(aws apigatewayv2 get-integrations --api-id "$API_ID" --query "Items[?IntegrationUri=='$uri'].IntegrationId | [0]" --output text)
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    id=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
      --payload-format-version 2.0 --integration-uri "$uri" --timeout-in-millis 29000 --query IntegrationId --output text)
  fi
  ok aws lambda add-permission --function-name "$fn" --statement-id "apigw-$API_ID" --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*"
  echo "$id"
}

EXISTING_ROUTES=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' --output text | tr '\t' '\n')
route() { # route key, integration id
  if ! echo "$EXISTING_ROUTES" | grep -qxF "$1"; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$2" >/dev/null
    echo "  route $1"
  fi
}

JOBS_INT=$(integration_for "$FN_JOBS")
CAND_INT=$(integration_for "$FN_CANDIDATES")
PIPE_INT=$(integration_for "$FN_PIPELINE")

# Marwan: auth, jobs, departments, analytics
for r in "GET /api/health/jobs" "ANY /api/auth/{proxy+}" "ANY /api/jobs" "ANY /api/jobs/{proxy+}" \
         "ANY /api/departments" "ANY /api/departments/{proxy+}" "ANY /api/analytics/{proxy+}"; do route "$r" "$JOBS_INT"; done
# Laila: candidates, applications
for r in "GET /api/health/candidates" "ANY /api/candidates/{proxy+}" "ANY /api/applications" "ANY /api/applications/{proxy+}"; do route "$r" "$CAND_INT"; done
# May: pipeline
for r in "GET /api/health/pipeline" "ANY /api/pipeline/{proxy+}"; do route "$r" "$PIPE_INT"; done

# Stage with throttling: protects the Lambdas (and the bill) from request floods
if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' >/dev/null 2>&1; then
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy \
    --default-route-settings ThrottlingBurstLimit=100,ThrottlingRateLimit=50 >/dev/null
fi
ok aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
  --default-route-settings ThrottlingBurstLimit=100,ThrottlingRateLimit=50

echo "  API_URL=$(api_url)"
