// One error shape for the whole API:
//   { "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [...] } }
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, 'VALIDATION_ERROR', message, details);
const unauthorized = (message = 'Authentication required.') => new ApiError(401, 'UNAUTHENTICATED', message);
const forbidden = (message = 'You do not have permission to do this.') => new ApiError(403, 'FORBIDDEN', message);
const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found.`);
const conflict = (message, code = 'CONFLICT') => new ApiError(409, code, message);
const tooMany = (message = 'Too many requests. Please slow down.') => new ApiError(429, 'RATE_LIMITED', message);
const badGateway = (message = 'A dependent service is unavailable.') => new ApiError(502, 'DEPENDENCY_FAILED', message);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, tooMany, badGateway };
