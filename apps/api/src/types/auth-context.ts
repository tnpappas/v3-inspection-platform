/**
 * Authentication context types and Express type augmentation.
 *
 * `AuthenticatedUser` is what Passport's verify callback returns and what we
 * read off `req.user` in protected routes. It is account-scoped (per Pattern 1
 * in the schema: each user belongs to exactly one account) and carries a
 * snapshot of the user's accessible businesses + effective permissions for
 * the active session.
 *
 * Effective permissions are computed once at login (or session refresh) by
 * @v3/permissions/resolver and cached on the session. Permission changes
 * during a session (role grants, override toggles) invalidate the cache and
 * the next request re-resolves.
 */

import type { Role } from '@v3/db/schema';

export interface AuthenticatedUser {
  /** users.id */
  id: string;
  /** users.account_id */
  accountId: string;
  /** users.email (lowercased) */
  email: string;
  /** users.display_name */
  displayName: string;
  /** users.is_system; must always be false for an authenticated user */
  isSystem: false;
  /**
   * Businesses the user belongs to within their account.
   * Drives RLS context: the array values populate `app.user_business_ids`.
   */
  businesses: Array<{
    businessId: string;
    roles: Role[];
  }>;
  /**
   * Active business context selected by the user (via the business switcher).
   * Null on routes that operate across all owned businesses (owner dashboard).
   */
  activeBusinessId: string | null;
  /**
   * Effective permissions for the active business, computed at session start
   * per security spec S11. Stored as a Set for O(1) checks in middleware.
   * Serialized as string[] on the wire / in session storage.
   */
  permissions: Set<string>;
  /** Session metadata */
  sessionId: string;
  mfaSatisfied: boolean;
}

/**
 * Express type augmentation. Lets route handlers read `req.user` as a typed
 * AuthenticatedUser when behind the authRequired middleware.
 *
 * The base Express.User type is intentionally permissive (empty interface
 * from @types/passport). Declaration merging here narrows it.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User extends AuthenticatedUser {}
    interface Request {
      user?: User;
    }
  }
}
