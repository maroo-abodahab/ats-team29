// Simple fixed-window rate limiter kept in memory.
// Limitation (documented in the report): each warm Lambda container has its own
// counter, so this slows down a single client but is not a global limit. The login
// endpoint ALSO has a per-account lockout stored in DynamoDB, which IS global.
const { tooMany } = require('./errors');
const { log } = require('./logger');

function rateLimit({ windowMs = 60_000, max = 60, keyPrefix = 'api' } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${req.clientIp || req.ip}`;
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; hits.set(key, entry); }
    entry.count += 1;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      log.security('RATE_LIMITED', { key: keyPrefix, ip: req.clientIp, path: req.path });
      return next(tooMany());
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    return next();
  };
}

module.exports = { rateLimit };
