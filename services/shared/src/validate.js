// Server-side input validation used by every endpoint.
// The frontend also checks forms, but ONLY this check counts: a request can be
// sent with curl or Postman, skipping the browser completely.
//
//   const body = validate(req.body, {
//     title:    { type: 'string', required: true, min: 3, max: 120 },
//     openings: { type: 'integer', min: 1, max: 50 },
//     status:   { type: 'string', enum: ['draft', 'published'] }
//   });
//
// Rules: unknown fields are rejected (so a client can never send "role" or
// "candidateId" and have it saved), strings are trimmed, and every problem is
// reported at once as { field, message }.
const { badRequest } = require('./errors');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkField(name, raw, rule, errors, coerce) {
  let value = raw;
  const fail = (message) => { errors.push({ field: name, message }); return undefined; };

  if (value === undefined || value === null || value === '') {
    if (rule.required) return fail('is required');
    return rule.default !== undefined ? rule.default : undefined;
  }

  switch (rule.type) {
    case 'string':
    case 'email':
    case 'uuid': {
      if (typeof value !== 'string') return fail('must be text');
      value = value.trim();
      if (rule.min !== undefined && value.length < rule.min) return fail(`must be at least ${rule.min} characters`);
      if (rule.max !== undefined && value.length > rule.max) return fail(`must be at most ${rule.max} characters`);
      if (rule.type === 'email') { value = value.toLowerCase(); if (!EMAIL_RE.test(value)) return fail('must be a valid email address'); }
      if (rule.type === 'uuid' && !UUID_RE.test(value)) return fail('must be a valid id');
      if (rule.pattern && !rule.pattern.test(value)) return fail(rule.patternMessage || 'has an invalid format');
      break;
    }
    case 'integer':
    case 'number': {
      if (coerce && typeof value === 'string' && value.trim() !== '') value = Number(value);
      if (typeof value !== 'number' || Number.isNaN(value)) return fail('must be a number');
      if (rule.type === 'integer' && !Number.isInteger(value)) return fail('must be a whole number');
      if (rule.min !== undefined && value < rule.min) return fail(`must be at least ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) return fail(`must be at most ${rule.max}`);
      break;
    }
    case 'boolean': {
      if (coerce && (value === 'true' || value === 'false')) value = value === 'true';
      if (typeof value !== 'boolean') return fail('must be true or false');
      break;
    }
    case 'date': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fail('must be a valid date/time (ISO 8601)');
      const time = Date.parse(value);
      if (rule.future && time <= Date.now()) return fail('must be in the future');
      value = new Date(time).toISOString();
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) return fail('must be a list');
      if (rule.maxItems !== undefined && value.length > rule.maxItems) return fail(`must have at most ${rule.maxItems} items`);
      if (rule.items) {
        const cleaned = [];
        value.forEach((item, i) => { const v = checkField(`${name}[${i}]`, item, rule.items, errors, coerce); if (v !== undefined) cleaned.push(v); });
        value = cleaned;
      }
      break;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return fail('must be an object');
      if (rule.schema) value = validateInto(value, rule.schema, errors, { coerce, prefix: `${name}.` });
      break;
    }
    default:
      return fail('has an unsupported type');
  }

  if (rule.enum && !rule.enum.includes(value)) return fail(`must be one of: ${rule.enum.join(', ')}`);
  return value;
}

function validateInto(input, schema, errors, { coerce = false, prefix = '', allowUnknown = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  if (!allowUnknown) {
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) errors.push({ field: prefix + key, message: 'is not allowed' });
    }
  }
  const out = {};
  for (const [name, rule] of Object.entries(schema)) {
    const v = checkField(prefix + name, source[name], rule, errors, coerce);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

// Throws 400 VALIDATION_ERROR listing every problem, or returns the cleaned object.
function validate(input, schema, options = {}) {
  const errors = [];
  const out = validateInto(input, schema, errors, options);
  if (errors.length) throw badRequest('Some fields are invalid.', errors);
  return out;
}

// Query strings arrive as text: coerce numbers/booleans, and ignore unknown params safely.
const validateQuery = (query, schema) => validate(query, schema, { coerce: true });

function requireUuid(value, name = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw badRequest(`Invalid ${name}.`, [{ field: name, message: 'must be a valid id' }]);
  return value;
}

module.exports = { validate, validateQuery, requireUuid, EMAIL_RE, UUID_RE };
