/**
 * Health, build, and time endpoints.
 *
 * - GET /api/health: lightweight liveness probe. No DB lookup, no auth.
 *   Used by Replit Deployments for readiness checks.
 * - GET /api/build: metadata about the running binary. Useful for diagnosing
 *   stale deploys.
 * - GET /api/time: server-side clock. Migrated from ISN's `/time` endpoint
 *   pattern; lets clients compute clock skew.
 *
 * None of these are auth-protected. Per spec 02 they live under /api but
 * outside the authenticated routes.
 */

import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
  });
});

healthRouter.get('/build', (_req, res) => {
  res.json({
    version: process.env.npm_package_version ?? '0.0.0',
    commit: process.env.GIT_COMMIT ?? 'unknown',
    nodeVersion: process.version,
    startedAt: process.env.SERVER_STARTED_AT ?? null,
  });
});

healthRouter.get('/time', (_req, res) => {
  res.json({
    time: new Date().toISOString(),
    epochMs: Date.now(),
    timezone: process.env.TZ ?? 'UTC',
  });
});
