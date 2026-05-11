/**
 * Error-envelope middleware + ApiError class.
 *
 * Every API error response uses the shape:
 *   {
 *     error: {
 *       code: 'permission_denied',
 *       message: 'Human-readable message',
 *       details: { ... },
 *       requestId: '<uuid>'
 *     }
 *   }
 *
 * Per the spec 02 conventions and security spec S9: cross-account or
 * no-permission hides return 404 (handled at the route layer or via the
 * 404 helper below), NOT 403. 403 is only returned when the user can see
 * the entity exists but lacks the action permission.
 */

import type { ErrorRequestHandler, Request, Response } from 'express';
import { ZodError } from 'zod';

export type ErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'semantic_error'
  | 'rate_limited'
  | 'system_user_login_attempted'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: ErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 404 helpers. NOT_FOUND is returned for:
 *   - missing routes
 *   - entities that do not exist
 *   - entities the requester cannot see (RLS hides them)
 *   - entities in another account (account isolation per S9)
 *
 * Only routes that can confirm the entity exists but the user lacks the
 * action permission should return PermissionDeniedError instead.
 */
export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found', details: Record<string, unknown> = {}) {
    super(404, 'not_found', message, details);
  }
}

export class UnauthenticatedError extends ApiError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthenticated', message);
  }
}

export class PermissionDeniedError extends ApiError {
  constructor(
    message = 'Permission denied',
    details: { required?: string[]; missing?: string[] } = {},
  ) {
    super(403, 'permission_denied', message, details as Record<string, unknown>);
  }
}

export class ConflictError extends ApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(409, 'conflict', message, details);
  }
}

export class SemanticError extends ApiError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(422, 'semantic_error', message, details);
  }
}

/**
 * Express 404 handler. Mount AFTER all routes, BEFORE errorHandler.
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: 'Resource not found',
      details: {},
      requestId: req.requestId,
    },
  });
}

/**
 * Express error handler. Mount LAST.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId: req.requestId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Request validation failed',
        details: { field_errors: err.flatten().fieldErrors },
        requestId: req.requestId,
      },
    });
    return;
  }

  // Unknown error. Log full detail server-side, sanitize for client.
  console.error(`[error] ${req.requestId} ${req.method} ${req.path}`, err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Internal server error',
      details: {},
      requestId: req.requestId,
    },
  });
};
