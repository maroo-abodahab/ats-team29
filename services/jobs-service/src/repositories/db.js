// Postgres (Neon) connection for the jobs service.
// The connection string is NOT in the code or in Lambda env vars: it is read from
// Secrets Manager (secret "ats/jobs-db") the first time it is needed.
// Neon requires TLS (sslmode=require in the URL), so data is encrypted in transit.
const { Pool } = require('pg');
const { getSecret } = require('@ats/shared');

let poolPromise;

async function createPool() {
  const { databaseUrl } = await getSecret(process.env.JOBS_DB_SECRET_ID || 'ats/jobs-db');
  const url = new URL(databaseUrl);
  const needsTls = url.searchParams.get('sslmode') === 'require' || url.hostname.endsWith('neon.tech');
  return new Pool({
    connectionString: databaseUrl,
    ssl: needsTls ? { rejectUnauthorized: true } : false,
    max: 2,                    // a Lambda container handles one request at a time
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000
  });
}

async function query(text, params = []) {
  if (!poolPromise) poolPromise = createPool().catch((err) => { poolPromise = undefined; throw err; });
  const pool = await poolPromise;
  return pool.query(text, params); // always parameterised ($1, $2 ...): no SQL injection
}

async function withTransaction(fn) {
  if (!poolPromise) poolPromise = createPool();
  const pool = await poolPromise;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn((text, params = []) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction };
