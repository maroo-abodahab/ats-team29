// Creates/updates the jobs database tables (services/jobs-service/db/schema.sql).
// The connection string is read from Secrets Manager (ats/jobs-db), never typed here.
// On a laptop the local stand-in is reached at localhost instead of "ats-postgres".
const fs = require('fs');
const path = require('path');

const servicesDir = path.join(__dirname, '..', 'services', 'jobs-service');
const req = (m) => require(require.resolve(m, { paths: [servicesDir] }));
const { Client } = req('pg');
const { SecretsManagerClient, GetSecretValueCommand } = req('@aws-sdk/client-secrets-manager');

(async () => {
  const sm = new SecretsManagerClient({});
  const out = await sm.send(new GetSecretValueCommand({ SecretId: process.env.JOBS_DB_SECRET_ID || 'ats/jobs-db' }));
  let { databaseUrl } = JSON.parse(out.SecretString);
  const url = new URL(databaseUrl);
  if (url.hostname === 'ats-postgres') { url.hostname = 'localhost'; url.port = '15432'; databaseUrl = url.toString(); }
  const tls = url.searchParams.get('sslmode') === 'require' || url.hostname.endsWith('neon.tech');

  const client = new Client({ connectionString: databaseUrl, ssl: tls ? { rejectUnauthorized: true } : false });
  await client.connect();
  await client.query(fs.readFileSync(path.join(servicesDir, 'db', 'schema.sql'), 'utf8'));
  const { rows } = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1");
  console.log(`  schema OK on ${tls ? 'Neon' : 'local Postgres'}: ${rows.map((r) => r.table_name).join(', ')}`);
  await client.end();
})().catch((err) => {
  console.error(`  migration failed: ${err.message}`);
  process.exit(1);
});
