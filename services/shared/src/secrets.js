// Secrets come from AWS Secrets Manager at runtime, never from the code.
//   ats/auth      {"jwtSecret": "...", "serviceSecret": "..."}   (every service)
//   ats/jobs-db   {"databaseUrl": "postgres://..."}              (jobs service only)
//   ats/email     {"brevoApiKey": "...", "senderEmail": "..."}  (notifier only)
// Each Lambda's IAM role may read ONLY the secrets it needs (least privilege).
// Values are cached for 5 minutes so we don't call Secrets Manager on every request,
// and a rotated secret is picked up within 5 minutes without a redeploy.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({});
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

async function getSecret(secretId) {
  const hit = cache.get(secretId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = JSON.parse(out.SecretString);
  cache.set(secretId, { value, expires: Date.now() + TTL_MS });
  return value;
}

module.exports = { getSecret };
