/**
 * @v3/db root barrel.
 *
 * Subpath imports (recommended for tree-shaking):
 *   import { inspections } from '@v3/db/schema';
 *   import { getDb } from '@v3/db/client';
 *   import { withRlsContext } from '@v3/db/rls';
 *
 * Or import everything from the root:
 *   import { schema, getDb, withRlsContext } from '@v3/db';
 */
export * as schema from './schema.js';
export { getDb, closeDb, type Db } from './client.js';
export {
  withRlsContext,
  withoutRlsContext,
  type RlsContext,
  type RlsTransaction,
} from './rls.js';
