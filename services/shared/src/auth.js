// Shared identity for all three services (led by Marwan).
//
// User tokens:    signed JWT, HS256 only, 1 hour, audience "ats-web".
//                 Payload: sub (user id), role, email, name. The role is set by the
//                 server at login and can never be chosen by the client.
// Service tokens: a DIFFERENT secret and audience "ats-internal", 60 seconds.
//                 Used when one service calls another (e.g. pipeline -> candidates).
//                 A user token can never pass as a service token and vice versa.
const jwt = require('jsonwebtoken');
const { getSecret } = require('./secrets');
const { unauthorized, forbidden } = require('./errors');
const { log } = require('./logger');

const ROLES = Object.freeze({ CANDIDATE: 'candidate', RECRUITER: 'recruiter', HIRING_MANAGER: 'hiring_manager' });
const AUTH_SECRET_ID = () => process.env.AUTH_SECRET_ID || 'ats/auth';
const ISSUER = 'ats-auth';

async function signUserToken(user) {
  const { jwtSecret } = await getSecret(AUTH_SECRET_ID());
  return jwt.sign(
    { role: user.role, email: user.email, name: user.name },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '1h', subject: user.userId, issuer: ISSUER, audience: 'ats-web' }
  );
}

async function signServiceToken(callerService) {
  const { serviceSecret } = await getSecret(AUTH_SECRET_ID());
  return jwt.sign({ svc: callerService }, serviceSecret,
    { algorithm: 'HS256', expiresIn: '60s', issuer: ISSUER, audience: 'ats-internal' });
}

function bearer(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

// 401 when there is no valid user token.
function requireAuth() {
  return async (req, res, next) => {
    const token = bearer(req);
    if (!token) {
      log.security('AUTH_FAILED', { reason: 'missing_token', method: req.method, path: req.path, ip: req.clientIp });
      return next(unauthorized());
    }
    try {
      const { jwtSecret } = await getSecret(AUTH_SECRET_ID());
      const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: 'ats-web' });
      req.user = { userId: claims.sub, role: claims.role, email: claims.email, name: claims.name };
      return next();
    } catch (err) {
      log.security('AUTH_FAILED', { reason: err.name, method: req.method, path: req.path, ip: req.clientIp });
      return next(unauthorized(err.name === 'TokenExpiredError' ? 'Session expired. Please log in again.' : 'Invalid token.'));
    }
  };
}

// Same as requireAuth but lets anonymous visitors through (req.user stays undefined).
function optionalAuth() {
  const strict = requireAuth();
  return (req, res, next) => (bearer(req) ? strict(req, res, next) : next());
}

// 403 when the logged-in user's role is not in the allowed list.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      log.security('ACCESS_DENIED', { userId: req.user.userId, role: req.user.role, needed: roles, method: req.method, path: req.path });
      return next(forbidden());
    }
    return next();
  };
}

// Internal routes: only another ATS service holding a fresh service token may call them.
function requireService() {
  return async (req, res, next) => {
    const token = bearer(req);
    try {
      if (!token) throw new Error('missing');
      const { serviceSecret } = await getSecret(AUTH_SECRET_ID());
      const claims = jwt.verify(token, serviceSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: 'ats-internal' });
      req.caller = claims.svc;
      return next();
    } catch (err) {
      log.security('INTERNAL_AUTH_FAILED', { method: req.method, path: req.path });
      return next(unauthorized('Internal endpoint.'));
    }
  };
}

module.exports = { ROLES, signUserToken, signServiceToken, requireAuth, optionalAuth, requireRole, requireService };
