/**
 * Request-ID middleware.
 *
 * Every incoming request gets a UUID v4 attached at `req.requestId`. The same
 * id is returned in the `x-request-id` response header, and reused by:
 *   - error envelope responses (so clients can quote it in support tickets)
 *   - audit_log writer (for forensic correlation per security spec S5)
 *   - pino-http logs
 *
 * If the client supplies `x-request-id` on the request, we honor it; this
 * lets upstream proxies preserve a trace id across hops.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && isUuidLike(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  };
}

function isUuidLike(s: string): boolean {
  // Permissive: accept anything that looks like a uuid v4. We do not enforce
  // version digits since some upstreams supply v7/ULID-shaped trace ids.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
