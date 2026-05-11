/**
 * RLS context helpers per security spec S1 and S9.
 *
 * Every authenticated DB operation runs inside a transaction with two
 * Postgres session variables set:
 *   - app.current_account_id  (uuid of the requester's account)
 *   - app.user_business_ids   (comma-separated uuids of accessible businesses)
 *
 * The 0001_rls_policies.sql migration installs RLS policies that read these
 * vars via two STABLE helper functions (app_current_account_id /
 * app_user_business_ids). Missing/empty vars cause the policies to return
 * zero rows, which is the safe failure mode.
 *
 * Usage from a route handler:
 *   const rows = await withRlsContext(getDb(), ctx, async (tx) => {
 *     return tx.select().from(inspections);
 *   });
 *
 * Implementation note: `SET LOCAL` does NOT accept bind parameters, so we
 * have to interpolate. We hand-validate UUIDs (whitelist regex) before
 * interpolation to keep the attack surface zero. Invalid UUIDs throw before
 * any SQL hits the wire.
 */

import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { NeonQueryResultHKT } from 'drizzle-orm/neon-serverless';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { Db } from './client.js';
import type * as schema from './schema.js';

export interface RlsContext {
  /** Requester's account UUID. */
  accountId: string;
  /** UUIDs of businesses the requester belongs to in their account. May be empty for account-only routes. */
  businessIds: string[];
}

/**
 * Drizzle transaction type matching the Neon serverless db.transaction callback parameter.
 */
export type RlsTransaction = PgTransaction<
  NeonQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): string {
  if (!UUID_REGEX.test(value)) {
    throw new Error(`Invalid UUID for RLS context (${label}): ${value}`);
  }
  return value;
}

/**
 * Opens a transaction, sets RLS session vars, runs the callback, commits.
 * The session vars are `SET LOCAL` and clear automatically at COMMIT.
 */
export async function withRlsContext<T>(
  db: Db,
  ctx: RlsContext,
  fn: (tx: RlsTransaction) => Promise<T>,
): Promise<T> {
  const accountId = assertUuid(ctx.accountId, 'accountId');
  const businessIds = ctx.businessIds.map((b, i) => assertUuid(b, `businessIds[${i}]`));
  const businessIdsCsv = businessIds.join(',');

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.current_account_id = '${accountId}'`));
    await tx.execute(sql.raw(`SET LOCAL app.user_business_ids = '${businessIdsCsv}'`));
    return fn(tx);
  });
}

/**
 * For system-level work (background jobs, migration helpers) that must
 * bypass RLS. Runs inside a transaction with both session vars EXPLICITLY
 * unset, which makes the RLS policies return zero rows. Use only with
 * raw queries that intentionally read across accounts.
 *
 * NOTE: this is not a true RLS bypass. It is a deliberate fail-closed mode.
 * For genuine system work that needs cross-account reads, use a dedicated
 * Postgres role that owns the tables and is exempt from FORCE RLS.
 */
export async function withoutRlsContext<T>(
  db: Db,
  fn: (tx: RlsTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`RESET app.current_account_id`));
    await tx.execute(sql.raw(`RESET app.user_business_ids`));
    return fn(tx);
  });
}
