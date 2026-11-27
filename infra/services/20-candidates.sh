#!/usr/bin/env bash
# [Laila] Candidates & Applications service
#   DynamoDB AtsCandidates, AtsApplications (+ candidate-index, job-index)
#   S3 private CV bucket (encrypted, versioned, no public access) | SQS events queue + DLQ
#   IAM role ats-candidates-role | Lambda ats-candidates-service
source "$(dirname "$0")/../lib.sh"
step "Candidates service (Laila)"
create_table AtsCandidates "AttributeName=userId,AttributeType=S" "AttributeName=userId,KeyType=HASH"
create_table AtsApplications \
  "AttributeName=applicationId,AttributeType=S AttributeName=candidateId,AttributeType=S AttributeName=jobId,AttributeType=S AttributeName=submittedAt,AttributeType=S" \
  "AttributeName=applicationId,KeyType=HASH" \
  '[{"IndexName":"candidate-index","KeySchema":[{"AttributeName":"candidateId","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},{"IndexName":"job-index","KeySchema":[{"AttributeName":"jobId","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]'

echo "  S3 bucket $CV_BUCKET (private CVs)"
ok aws s3api create-bucket --bucket "$CV_BUCKET"
aws s3api put-public-access-block --bucket "$CV_BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$CV_BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-versioning --bucket "$CV_BUCKET" --versioning-configuration Status=Enabled
# Old CV versions (after a replace) are removed after 30 days to limit storage cost
ok aws s3api put-bucket-lifecycle-configuration --bucket "$CV_BUCKET" --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-old-cv-versions","Status":"Enabled","Filter":{"Prefix":"cvs/"},"NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}'

echo "  SQS $QUEUE (+ dead-letter queue $DLQ)"
ok aws sqs create-queue --queue-name "$DLQ" --attributes MessageRetentionPeriod=1209600
DLQ_ARN="arn:aws:sqs:$REGION:$ACCOUNT:$DLQ"
ATTRS=$(node -e 'console.log(JSON.stringify({RedrivePolicy: JSON.stringify({deadLetterTargetArn: process.argv[1], maxReceiveCount: "3"}), VisibilityTimeout: "60"}))' "$DLQ_ARN")
echo "$ATTRS" > "$TMP_DIR/queue-attrs.json"
if ! aws sqs get-queue-url --queue-name "$QUEUE" >/dev/null 2>&1; then
  aws sqs create-queue --queue-name "$QUEUE" --attributes "file://$TMP_DIR/queue-attrs.json" >/dev/null
else
  aws sqs set-queue-attributes --queue-url "$(aws sqs get-queue-url --queue-name "$QUEUE" --query QueueUrl --output text)" --attributes "file://$TMP_DIR/queue-attrs.json"
fi

create_role "$ROLE_CANDIDATES" "$INFRA_DIR/iam/candidates-policy.json"
ENV="{\"Variables\":{\"NODE_ENV\":\"production\",\"SERVICE_NAME\":\"candidates-service\",\"CANDIDATES_TABLE\":\"AtsCandidates\",\"APPLICATIONS_TABLE\":\"AtsApplications\",\"CV_BUCKET\":\"$CV_BUCKET\",\"S3_PUBLIC_ENDPOINT\":\"$S3_PUBLIC_ENDPOINT\",\"APPLICATION_QUEUE\":\"$QUEUE\",\"CORS_ORIGINS\":\"$WEB_ORIGIN\",\"JOBS_FUNCTION\":\"$FN_JOBS\",\"PIPELINE_FUNCTION\":\"$FN_PIPELINE\"}}"
deploy_function "$FN_CANDIDATES" "$ROLE_CANDIDATES" candidates-service src/lambda.handler "$ENV" 256 15
