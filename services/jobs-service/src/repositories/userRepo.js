// User accounts in DynamoDB table AtsUsers (shared identity, owned by Marwan).
//   Partition key: userId
//   GSI email-index: email -> user (for login)
// Email uniqueness is guaranteed with a transaction that also writes a small
// "EMAIL#<email>" lock item; if that item already exists the whole write fails.
const { randomUUID } = require('crypto');
const { GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, readAll, conflict } = require('@ats/shared');

const TABLE = () => process.env.USERS_TABLE || 'AtsUsers';
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

// Never send passwordHash or lockout counters to a client.
function publicUser(u) {
  if (!u) return null;
  return { userId: u.userId, name: u.name, email: u.email, role: u.role, active: u.active !== false, createdAt: u.createdAt };
}

async function getById(userId) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { userId } }));
  return out.Item && out.Item.type === 'user' ? out.Item : null;
}

async function getByEmail(email) {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE(),
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': email }
  }));
  return (out.Items || []).find((i) => i.type === 'user') || null;
}

async function create({ name, email, passwordHash, role, createdBy }) {
  const user = {
    userId: randomUUID(),
    type: 'user',
    name,
    email,
    passwordHash,
    role,
    active: true,
    failedLogins: 0,
    createdBy: createdBy || 'self-registration',
    createdAt: new Date().toISOString()
  };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE(), Item: { userId: `EMAIL#${email}`, type: 'email-lock', owner: user.userId }, ConditionExpression: 'attribute_not_exists(userId)' } },
        { Put: { TableName: TABLE(), Item: user, ConditionExpression: 'attribute_not_exists(userId)' } }
      ]
    }));
  } catch (err) {
    if (err.name === 'TransactionCanceledException' || err.name === 'ConditionalCheckFailedException') {
      throw conflict('An account with this email already exists.', 'EMAIL_TAKEN');
    }
    throw err;
  }
  return user;
}

// Returns the updated user; locks the account after 5 failures in a row.
async function recordFailedLogin(user) {
  const failed = (user.failedLogins || 0) + 1;
  const lockedUntil = failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
  const out = await ddb.send(new UpdateCommand({
    TableName: TABLE(),
    Key: { userId: user.userId },
    UpdateExpression: 'SET failedLogins = :f, lockedUntil = :l, lastFailedLoginAt = :now',
    ExpressionAttributeValues: { ':f': lockedUntil ? 0 : failed, ':l': lockedUntil, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW'
  }));
  return { user: out.Attributes, locked: Boolean(lockedUntil) };
}

async function recordSuccessfulLogin(userId) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE(),
    Key: { userId },
    UpdateExpression: 'SET failedLogins = :z, lockedUntil = :n, lastLoginAt = :now',
    ExpressionAttributeValues: { ':z': 0, ':n': null, ':now': new Date().toISOString() }
  }));
}

async function setActive(userId, active) {
  const out = await ddb.send(new UpdateCommand({
    TableName: TABLE(),
    Key: { userId },
    UpdateExpression: 'SET active = :a',
    ConditionExpression: 'attribute_exists(userId) AND #t = :user',
    ExpressionAttributeNames: { '#t': 'type' },
    ExpressionAttributeValues: { ':a': active, ':user': 'user' },
    ReturnValues: 'ALL_NEW'
  }));
  return out.Attributes;
}

async function listStaff(role) {
  const roles = role ? [role] : ['recruiter', 'hiring_manager'];
  const items = await readAll((cmd) => ddb.send(new ScanCommand(cmd)), {
    TableName: TABLE(),
    FilterExpression: '#t = :user AND #r IN (' + roles.map((_, i) => `:r${i}`).join(',') + ')',
    ExpressionAttributeNames: { '#t': 'type', '#r': 'role' },
    ExpressionAttributeValues: Object.fromEntries([[':user', 'user'], ...roles.map((r, i) => [`:r${i}`, r])])
  });
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { publicUser, getById, getByEmail, create, recordFailedLogin, recordSuccessfulLogin, setActive, listStaff, MAX_FAILED_LOGINS, LOCK_MINUTES };
