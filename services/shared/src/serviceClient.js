// Service-to-service calls (the "how do the services talk to each other" part).
//
// In the cloud each service is its own Lambda function. One service calls another
// by INVOKING its Lambda directly with the AWS SDK. The call never leaves AWS, never
// goes through the public API Gateway, and IAM decides who may call whom: e.g. the
// pipeline role has lambda:InvokeFunction on the candidates and jobs functions only.
// On top of IAM, the request carries a 60-second service token (see auth.js) and
// only /api/internal/* routes accept it.
//
// On a laptop (SERVICE_TRANSPORT=http) the same call is a normal HTTP request to the
// other service running with `npm run dev`.
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { randomUUID } = require('crypto');
const { signServiceToken } = require('./auth');
const { ApiError, badGateway } = require('./errors');
const { log } = require('./logger');

const lambda = new LambdaClient({});
const TARGETS = ['jobs', 'candidates', 'pipeline'];

async function callService(target, method, path, { body, query } = {}) {
  if (!TARGETS.includes(target)) throw new Error(`Unknown service ${target}`);
  const caller = process.env.SERVICE_NAME || 'ats';
  const token = await signServiceToken(caller);
  const qs = query
    ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString()
    : '';
  const started = Date.now();
  let status;
  let data;

  try {
    if (process.env.SERVICE_TRANSPORT === 'http') {
      const base = process.env[`${target.toUpperCase()}_SERVICE_URL`];
      const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000)
      });
      status = res.status;
      data = res.status === 204 ? null : await res.json().catch(() => null);
    } else {
      const functionName = process.env[`${target.toUpperCase()}_FUNCTION`] || `ats-${target}-service`;
      const event = {
        version: '2.0',
        routeKey: '$default',
        rawPath: path,
        rawQueryString: qs,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ats-caller': caller },
        requestContext: {
          http: { method, path, sourceIp: '127.0.0.1', protocol: 'HTTP/1.1', userAgent: caller },
          requestId: randomUUID(),
          stage: '$default'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        isBase64Encoded: false
      };
      const out = await lambda.send(new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(JSON.stringify(event))
      }));
      if (out.FunctionError) throw new Error(`Function error in ${functionName}`);
      const payload = JSON.parse(Buffer.from(out.Payload).toString('utf8'));
      status = payload.statusCode;
      const raw = payload.isBase64Encoded ? Buffer.from(payload.body || '', 'base64').toString('utf8') : payload.body;
      data = raw ? JSON.parse(raw) : null;
    }
  } catch (err) {
    log.error('SERVICE_CALL_FAILED', { target, method, path, error: err.message, ms: Date.now() - started });
    throw badGateway(`The ${target} service is unavailable right now.`);
  }

  log.info('SERVICE_CALL', { target, method, path, status, ms: Date.now() - started });
  return { status, data };
}

// Turn the other service's answer into either data or a clean error for our caller.
function expectOk({ status, data }, notFoundMessage) {
  if (status >= 200 && status < 300) return data;
  if (status === 404) throw new ApiError(404, 'NOT_FOUND', notFoundMessage || 'Related record not found.');
  if (status === 400 || status === 409) {
    throw new ApiError(status, data?.error?.code || 'CONFLICT', data?.error?.message || 'Request rejected by a related service.');
  }
  throw badGateway();
}

module.exports = { callService, expectOk };
