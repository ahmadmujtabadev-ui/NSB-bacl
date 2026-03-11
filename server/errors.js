export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message) { super(message, 400, 'VALIDATION_ERROR'); }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required') { super(message, 401, 'UNAUTHORIZED'); }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') { super(message, 403, 'FORBIDDEN'); }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(message, 404, 'NOT_FOUND'); }
}

export class ConflictError extends AppError {
  constructor(message) { super(message, 409, 'CONFLICT'); }
}

export class InsufficientCreditsError extends AppError {
  constructor(required = 0, available = 0) {
    super(`Insufficient credits. Required: ${required}, available: ${available}`, 402, 'INSUFFICIENT_CREDITS');
    this.required = required;
    this.available = available;
  }
}

export class AIProviderError extends Error {
  constructor(message, provider, statusCode = 502) {
    super(message);
    this.name = 'AIProviderError';
    this.code = 'AI_PROVIDER_ERROR';
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

/** Global error handler — mount as last Express middleware */
export function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'An unexpected error occurred';

  if (status >= 500) console.error(`[ERROR] ${code}:`, err);

  res.status(status).json({
    error: {
      code,
      message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
  });
}
