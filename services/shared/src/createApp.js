// Builds the Express app every service uses, so all of them share the same
// security middleware, logging and error format. Each service only adds its routes.
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const serverless = require('serverless-http');
const { randomUUID } = require('crypto');
const { ApiError } = require('./errors');
const { log } = require('./logger');

function createApp({ serviceName, healthPath, mount }) {
  process.env.SERVICE_NAME = process.env.SERVICE_NAME || serviceName;
  const app = express();
  app.disable('x-powered-by');
  // Never trust a client-sent X-Forwarded-For header (it would let a client fake its IP
  // and dodge the rate limit). The real IP comes from API Gateway's requestContext.
  app.set('trust proxy', false);

  // Request id + client IP + one access-log line per request
  app.use((req, res, next) => {
    req.id = randomUUID();
    req.clientIp = req.sourceIp || req.ip;
    res.set('X-Request-Id', req.id);
    const started = Date.now();
    res.on('finish', () => {
      log.info('HTTP_REQUEST', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        userId: req.user?.userId,
        role: req.user?.role,
        caller: req.caller
      });
    });
    next();
  });

  // Security headers (HSTS, nosniff, frame-ancestors none, no referrer, ...)
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }
  }));

  // CORS: only the ATS website may call the API from a browser.
  const allowed = (process.env.CORS_ORIGINS || 'http://localhost:4566,http://localhost:8080')
    .split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowed.includes(origin)),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600
  }));

  app.use(express.json({ limit: '4mb' }));

  // Some API Gateway emulators pass the body as raw bytes or base64 text (seen in Lab 7).
  app.use((req, res, next) => {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      const text = req.body.toString('utf8').trim();
      const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(text) && !text.startsWith('{') && !text.startsWith('[');
      const decoded = looksBase64 ? Buffer.from(text, 'base64').toString('utf8') : text;
      try {
        req.body = decoded ? JSON.parse(decoded) : {};
      } catch {
        return next(new ApiError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.'));
      }
    }
    if (req.body === undefined || req.body === null) req.body = {};
    return next();
  });

  app.get(healthPath, (req, res) => {
    res.json({
      status: 'ok',
      service: serviceName,
      runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'pc',
      time: new Date().toISOString()
    });
  });

  mount(app);

  app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`)));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let error = err;
    if (err.type === 'entity.parse.failed') {
      error = new ApiError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
    } else if (err.type === 'entity.too.large') {
      error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    } else if (!(err instanceof ApiError)) {
      log.error('UNHANDLED_ERROR', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        error: err.message,
        stack: err.stack?.split('\n').slice(0, 4).join(' | ')
      });
      error = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
    }
    if (error.status === 400) {
      log.security('VALIDATION_FAILED', {
        requestId: req.id,
        path: req.path,
        userId: req.user?.userId,
        fields: (error.details || []).map((d) => d.field)
      });
    }
    res.status(error.status).json({
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
    });
  });

  return app;
}

// Lambda entry point: API Gateway event -> Express request -> API Gateway response.
function lambdaHandler(app) {
  return serverless(app, {
    request(req, event) {
      req.sourceIp = event?.requestContext?.http?.sourceIp;
    }
  });
}

module.exports = { createApp, lambdaHandler };
