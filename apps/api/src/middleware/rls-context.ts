/**
 * RLS context middleware.
 *
 * Wraps route handlers that touch the database. Reads the authenticated user
 * from `req.user`, opens a Drizzle transaction with `app.current_account_id`
 * and `app.user_business_ids` session vars set, and exposes the transaction
 * as `req.db`. The RLS policies in `0001_rls_policies.sql` then filter every
 * query in the transaction to the user's account and businesses.
 *
 * Usage:
 *   router.get('/inspections', authRequired, rlsContext, async (req, res) => {
 *     const rows = await req.db.select().from(inspections);
 *     res.json({ data: rows });
 *   });
 *
 * Implementation: the middleware does NOT call next() inside the transaction.
 * Instead it stages `req.db`, calls next(), and after the response is sent
 * commits or rolls back via res.on('finish').
 *
 * Caveat: long-running streams or websockets must NOT use this middleware as
 * written. They need an explicit transaction scope.
 */

import type { Request, Response, NextFunction } from 'express';
import { getDb, withRlsContext, type RlsTransaction } from '@v3/db';
import { UnauthenticatedError } from './error-envelope.js';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Drizzle transaction with RLS session vars set for the authenticated
     * user's account and accessible businesses. Populated by `rlsContext`
     * middleware. Throws if accessed without that middleware.
     */
    db: RlsTransaction;
  }
}

/**
 * Express middleware that opens a transaction with RLS context, runs the
 * downstream chain, then commits.
 *
 * This is implemented as a route-wrapping pattern rather than a plain
 * middleware because Express middleware does not support awaiting after
 * next(). We use the Promise-returning factory style.
 */
export function rlsContext(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    next(new UnauthenticatedError('rlsContext requires authRequired upstream'));
    return;
  }

  const businessIds = user.businesses.map((b) => b.businessId);

  // Open transaction; capture next() error so we can roll back.
  void withRlsContext(
    getDb(),
    { accountId: user.accountId, businessIds },
    async (tx) => {
      req.db = tx;
      // Wait for the downstream chain to finish (response sent or error).
      await new Promise<void>((resolve, reject) => {
        res.once('finish', resolve);
        res.once('close', resolve);
        res.once('error', reject);
        next();
      });
    },
  ).catch((err: unknown) => {
    // If next() already responded, we cannot send another response. Log only.
    if (res.headersSent) {
      console.error(`[rls-context] tx failed after response (${req.requestId})`, err);
      return;
    }
    next(err);
  });
}
