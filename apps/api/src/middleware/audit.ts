/**
 * Audit log helpers per security spec S5 and S9 (INV-1).
 *
 * Every state-changing endpoint produces an `audit_log` row. The shape is
 * fixed in the schema and INV-1 requires `audit_log.account_id` to match the
 * audited entity's account.
 *
 * Usage from a route handler:
 *   await writeAuditLog(req, {
 *     action: 'update',
 *     entityType: 'inspection',
 *     entityId: inspection.id,
 *     businessId: inspection.businessId,
 *     changes: { before: prev, after: next },
 *   });
 *
 * `req` provides accountId (from req.user), sessionId, requestId, ipAddress,
 * userAgent. The caller supplies action-specific fields.
 *
 * `outcome` defaults to 'success'. Override to 'denied' / 'failed' / 'partial'
 * for permission rejections, runtime failures, and bulk-partials respectively.
 */

import type { Request } from 'express';
import { schema } from '@v3/db';
import type { RlsTransaction } from '@v3/db';

type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'view'
  | 'release'
  | 'override'
  | 'reschedule'
  | 'cancel'
  | 'login'
  | 'logout'
  | 'read_sensitive'
  | 'export';

type AuditOutcome = 'success' | 'denied' | 'failed' | 'partial';

export interface AuditLogInput {
  action: AuditAction;
  outcome?: AuditOutcome;
  entityType: string;
  entityId?: string | null;
  businessId?: string | null;
  changes?: {
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Writes an audit_log row using the RLS-scoped transaction on `req.db`.
 * INV-1 is satisfied automatically: `account_id` is taken from the
 * authenticated user, which is the only account the request can write to.
 *
 * If req.db is not present (route did not use rlsContext middleware), throws.
 */
export async function writeAuditLog(req: Request, input: AuditLogInput): Promise<void> {
  const user = req.user;
  if (!user) {
    throw new Error('writeAuditLog: req.user not set; mount authRequired upstream');
  }
  const tx = req.db;
  if (!tx) {
    throw new Error('writeAuditLog: req.db not set; mount rlsContext upstream');
  }

  const changesPayload = input.changes ?? {};
  const changesSize = Buffer.byteLength(JSON.stringify(changesPayload), 'utf8');
  if (changesSize > 64 * 1024) {
    throw new Error(`audit_log.changes payload too large: ${changesSize} bytes (max 65536)`);
  }

  await tx.insert(schema.auditLog).values({
    accountId: user.accountId,
    businessId: input.businessId ?? null,
    userId: user.id,
    action: input.action,
    outcome: input.outcome ?? 'success',
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    sessionId: user.sessionId,
    requestId: req.requestId,
    ipAddress: getClientIp(req) ?? null,
    userAgent: req.header('user-agent') ?? null,
    changes: changesPayload,
    changesSize,
  });
}

/**
 * Resolves the client IP from the request, honoring trusted proxies if
 * `app.set('trust proxy', ...)` is configured. Falls back to req.socket.
 */
function getClientIp(req: Request): string | null {
  // Express's req.ip honors trust proxy settings; if not configured, it
  // returns the direct socket address.
  if (req.ip) return req.ip;
  return req.socket.remoteAddress ?? null;
}

/**
 * Convenience: writes a denied-outcome audit entry. Used by permission
 * middleware when a check fails so the attempt is recorded even though no
 * mutation happened.
 */
export async function writeDeniedAuditLog(
  req: Request,
  input: Omit<AuditLogInput, 'outcome'> & { reason?: string },
): Promise<void> {
  const { reason, ...rest } = input;
  await writeAuditLog(req, {
    ...rest,
    outcome: 'denied',
    changes: {
      ...input.changes,
      metadata: { ...(input.changes?.metadata ?? {}), denied_reason: reason },
    },
  });
}

// Re-export so callers can import the helper without separately importing the schema type.
export type { RlsTransaction };
