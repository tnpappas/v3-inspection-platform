/**
 * Drizzle client factory for apps/api.
 *
 * Uses @neondatabase/serverless `Pool` over WebSocket. WebSocket is required
 * for transactional RLS: each authenticated request opens a transaction, runs
 * `SET LOCAL app.current_account_id` and `SET LOCAL app.user_business_ids`,
 * executes queries (RLS-filtered), then commits. The transaction-local session
 * vars auto-clear on COMMIT. The HTTP-mode `neon()` helper does NOT support
 * session state per query, so it cannot be used with our RLS contract.
 *
 * Migration scripts (run from Legion, not Replit) use the existing pg Pool in
 * scripts/helpers.ts and do not go through this client.
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema.js';

// Node 22+ ships WebSocket natively, but explicitly assigning `ws` is the
// documented pattern and protects against deployment environments that disable
// the native WebSocket global.
if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

let _pool: Pool | null = null;
let _db: NeonDatabase<typeof schema> | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL must be set. Run via `doppler run -- pnpm dev` so the Doppler v3-api/dev config injects it.',
    );
  }
  _pool = new Pool({ connectionString: url });
  return _pool;
}

/**
 * Lazy singleton Drizzle client. First call creates the pool; subsequent calls
 * reuse it. Safe to call from request handlers.
 */
export function getDb(): NeonDatabase<typeof schema> {
  if (!_db) {
    _db = drizzle(getPool(), { schema });
  }
  return _db;
}

/**
 * Closes the pool. Used in graceful shutdown and tests.
 */
export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = null;
  }
}

export type Db = NeonDatabase<typeof schema>;
export { schema };
