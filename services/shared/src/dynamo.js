// One DynamoDB DocumentClient per Lambda container (re-used between requests).
// No keys in code: on Lambda the function's IAM role gives permission; on a laptop
// the "floci" AWS profile does (AWS_PROFILE=floci).
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

// Read every page of a Query/Scan (DynamoDB returns at most 1 MB per call).
async function readAll(send, command) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const out = await send({ ...command, ExclusiveStartKey });
    items.push(...(out.Items || []));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

module.exports = { ddb, readAll };
