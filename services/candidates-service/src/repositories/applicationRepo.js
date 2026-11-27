// Job applications in DynamoDB table AtsApplications (owner: Laila).
//   Partition key: applicationId
//   GSI candidate-index (candidateId, submittedAt): "my applications"
//   GSI job-index       (jobId, submittedAt):       "applications for a job" (pipeline, analytics)
// The current stage lives here; the PIPELINE service moves it through a protected
// internal endpoint and keeps the full stage history in its own table.
const { randomUUID } = require('crypto');
const { GetCommand, PutCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, readAll } = require('@ats/shared');

const TABLE = () => process.env.APPLICATIONS_TABLE || 'AtsApplications';
const FINAL_STAGES = ['hired', 'rejected', 'withdrawn'];

async function get(applicationId) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { applicationId } }));
  return out.Item || null;
}

async function listByCandidate(candidateId) {
  const items = await readAll((cmd) => ddb.send(new QueryCommand(cmd)), {
    TableName: TABLE(),
    IndexName: 'candidate-index',
    KeyConditionExpression: 'candidateId = :c',
    ExpressionAttributeValues: { ':c': candidateId }
  });
  return items.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

async function listByJob(jobId) {
  return readAll((cmd) => ddb.send(new QueryCommand(cmd)), {
    TableName: TABLE(),
    IndexName: 'job-index',
    KeyConditionExpression: 'jobId = :j',
    ExpressionAttributeValues: { ':j': jobId }
  });
}

async function create(data) {
  const now = new Date().toISOString();
  const item = {
    applicationId: randomUUID(),
    ...data,
    currentStage: 'applied',
    submittedAt: now,
    stageUpdatedAt: now,
    updatedAt: now
  };
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item, ConditionExpression: 'attribute_not_exists(applicationId)' }));
  return item;
}

// Optimistic concurrency: the update only happens if the stage is still `fromStage`.
// Two recruiters clicking at the same time cannot both move the same application.
async function changeStage(applicationId, fromStage, toStage, extra = {}) {
  const now = new Date().toISOString();
  const sets = ['currentStage = :to', 'stageUpdatedAt = :now', 'updatedAt = :now'];
  const values = { ':to': toStage, ':from': fromStage, ':now': now };
  if (toStage === 'hired') sets.push('hiredAt = :now');
  if (toStage === 'withdrawn') { sets.push('withdrawnAt = :now'); }
  if (extra.rejectionReason) { sets.push('rejectionReason = :rr'); values[':rr'] = extra.rejectionReason; }
  if (extra.withdrawReason) { sets.push('withdrawReason = :wr'); values[':wr'] = extra.withdrawReason; }
  try {
    const out = await ddb.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { applicationId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'currentStage = :from',
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
    }));
    return out.Attributes;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

module.exports = { get, listByCandidate, listByJob, create, changeStage, FINAL_STAGES };
