// Candidate profiles in DynamoDB table AtsCandidates (owner: Laila).
//   Partition key: userId  (the candidate's user id from the JWT, so a candidate
//   can only ever read/write the item whose key is their own token's user id)
const { GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb } = require('@ats/shared');

const TABLE = () => process.env.CANDIDATES_TABLE || 'AtsCandidates';

async function get(userId) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { userId } }));
  return out.Item || null;
}

async function upsert(userId, email, profile) {
  const now = new Date().toISOString();
  const existing = await get(userId);
  const item = {
    ...(existing || { createdAt: now }),
    ...profile,
    userId,
    email,
    updatedAt: now
  };
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
  return { item, created: !existing };
}

async function setCv(userId, cv) {
  const out = await ddb.send(new UpdateCommand({
    TableName: TABLE(),
    Key: { userId },
    UpdateExpression: 'SET cv = :cv, updatedAt = :now',
    ConditionExpression: 'attribute_exists(userId)',
    ExpressionAttributeValues: { ':cv': cv, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_OLD'
  }));
  return out.Attributes?.cv || null; // previous CV, so its file can be deleted
}

module.exports = { get, upsert, setCv };
