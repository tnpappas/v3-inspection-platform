/**
 * Express app factory.
 *
 * `createApp()` returns a fully wired Express instance. Kept separate from
 * `index.ts` (which calls `app.listen`) so tests can spin up the app without
 * binding to a port.
 *
 * Middleware order is intentional:
 *   1. helmet                  (security headers, must be early)
 *   2. requestId               (every later middleware can log `req.requestId`)
 *   3. json body parser
 *   4. routes
 *   5. notFound handler        (catches unmatched routes)
 *   6. error handler           (must be last)
 *
 * Future middleware (added incrementally):
 *   - pino-http for structured request logs (after requestId)
 *   - rateLimit on /api/auth/login and other sensitive routes
 *   - session + Passport (after json parser, before routes)
 *   - RLS context (after auth, before routes that hit the DB)
 *   - PII mask (after routes, before send)
 */

import express, { type Express } from 'express';
import helmet from 'helmet';
import { requestIdMiddleware } from './middleware/request-id.js';
import { errorHandler, notFoundHandler } from './middleware/error-envelope.js';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  // Security headers
  app.use(helmet());

  // Request tracing
  app.use(requestIdMiddleware());

  // Body parsing (1MB cap; uploads will use multer on dedicated routes)
  app.use(express.json({ limit: '1mb' }));

  // Routes
  app.use('/api', healthRouter);

  // 404 + error must come last
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
