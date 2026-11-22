// Structured JSON logs. On Lambda, console output goes to CloudWatch Logs
// (/aws/lambda/<function>), where metric filters count security events.
// Sensitive values are NEVER logged: anything that looks like a password,
// token, secret or file content is replaced with "[REDACTED]".
const SENSITIVE = /pass(word)?|token|secret|authorization|apikey|api_key|cookie|content(base64)?$|cv(data|file)/i;

function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

const SERVICE = () => process.env.SERVICE_NAME || 'ats';

function write(level, event, details = {}) {
  const line = { level, event, service: SERVICE(), time: new Date().toISOString(), ...redact(details) };
  const text = JSON.stringify(line);
  if (level === 'ERROR') console.error(text);
  else console.log(text);
}

const log = {
  info: (event, details) => write('INFO', event, details),
  warn: (event, details) => write('WARN', event, details),
  error: (event, details) => write('ERROR', event, details),
  // Security events all carry level SECURITY so one CloudWatch filter finds them.
  // Event names used: LOGIN_SUCCESS, LOGIN_FAILED, ACCOUNT_LOCKED, AUTH_FAILED,
  // ACCESS_DENIED, OWNERSHIP_DENIED, VALIDATION_FAILED, RATE_LIMITED, ...
  security: (event, details) => write('SECURITY', event, details)
};

module.exports = { log, redact };
