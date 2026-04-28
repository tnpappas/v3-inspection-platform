/**
 * migrate-history.ts — Steps 5 & 6: Audit history import and reschedule
 * history reconstruction.
 *
 * For every imported inspection, calls GET /order/history/{isnOrderId} and:
 *   - Creates audit_log rows (dedup via requestId = isnEventHash)
 *   - Detects reschedule events and creates reschedule_history rows
 *     (dedup via unique index on inspection_id, prev_at, new_at)
 *
 * Idempotent: safe to re-run. Already-imported events are skipped silently.
 *
 * Run: npx tsx specs/migration/migrate-history.ts
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  pool,
  log,
  logError,
  isnGetThrottled,
  parseIsnDatetime,
  isnEventHash,
  ISNOrderDetail,
} from "./helpers";
import { auditLog, rescheduleHistory } from "../01-schema";

const db = drizzle(pool, { schema: { auditLog, rescheduleHistory } });

interface ISNHistoryEvent {
  uid: string | null;
  by: string;
  when: string;
  changes: Record<string, string>;
}

async function lookupUserByIsnUid(
  isnUid: string | null,
  accountId: string,
  systemUserId: string
): Promise<string> {
  if (!isnUid) return systemUserId;
  const rows = await pool.query(
    `SELECT id FROM users WHERE account_id = $1 AND isn_source_id = $2 LIMIT 1`,
    [accountId, isnUid]
  );
  return rows.rows[0]?.id ?? systemUserId;
}

/** Parse "04/21/2026" (ISN date format in history changes) to ISO string. */
function parseIsnHistoryDate(d: string | null | undefined): string | null {
  if (!d || d === "No Date") return null;
  // MM/DD/YYYY → ISO
  const [m, day, y] = d.split("/");
  if (!m || !day || !y) return null;
  return `${y}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Parse "1:30 PM" to HH:MM (24h). */
function parseIsnHistoryTime(t: string | null | undefined): string | null {
  if (!t || t === "No Time") return null;
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${min}`;
}

async function main() {
  log("migrate-history", "Starting audit history and reschedule history import");

  const ACCOUNT_ID = process.env.MIGRATION_ACCOUNT_ID;
  const SAFEHOUSE_BIZ_ID = process.env.MIGRATION_SAFEHOUSE_BIZ_ID;
  if (!ACCOUNT_ID || !SAFEHOUSE_BIZ_ID) {
    throw new Error("Set MIGRATION_ACCOUNT_ID and MIGRATION_SAFEHOUSE_BIZ_ID env vars");
  }

  const systemEmail = `system@${process.env.SEED_ACCOUNT_SLUG ?? "pappas"}.local`;
  const sysRows = await pool.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [systemEmail]);
  const systemUserId = sysRows.rows[0]?.id;
  if (!systemUserId) throw new Error("System user not found. Run seed.ts first.");

  // Pull all imported inspections that have an ISN source ID
  const inspectionRows = await pool.query(
    `SELECT id, isn_source_id FROM inspections WHERE business_id = $1 AND isn_source_id IS NOT NULL ORDER BY created_at`,
    [SAFEHOUSE_BIZ_ID]
  ) as { rows: Array<{ id: string; isn_source_id: string }> };

  log("migrate-history", `Processing ${inspectionRows.rows.length} inspections`);

  let auditInserted = 0, rescheduleInserted = 0, alreadyDone = 0;

  for (const row of inspectionRows.rows) {
    const historyResp = await isnGetThrottled<{ history: ISNHistoryEvent[] }>(
      `/order/history/${row.isn_source_id}`
    ).catch(() => null);

    if (!historyResp?.history) continue;
    const events = historyResp.history;

    // Track the running state of scheduled_at as we walk forward through history
    let prevScheduledDate: string | null = null;
    let prevScheduledTime: string | null = null;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const dedup = isnEventHash(row.isn_source_id, event.when);
      const action = i === 0 ? "create" : "update";
      const createdAt = parseIsnDatetime(event.when);
      if (!createdAt) continue;

      const userId = await lookupUserByIsnUid(event.uid, ACCOUNT_ID, systemUserId);

      // Audit log insert (idempotent via requestId ON CONFLICT)
      const result = await pool.query(
        `INSERT INTO audit_log
           (id, account_id, business_id, user_id, action, outcome, entity_type, entity_id,
            changes, request_id, created_at)
         VALUES
           (gen_random_uuid(), $1, $2, $3, $4, 'success', 'inspection', $5, $6, $7, $8)
         ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING`,
        [
          ACCOUNT_ID,
          SAFEHOUSE_BIZ_ID,
          userId,
          action,
          row.id,
          JSON.stringify({
            ...event.changes,
            metadata: { context: "isn_history_import", isn_event_when: event.when, isn_actor_name: event.by },
          }),
          dedup,
          createdAt.toISOString(),
        ]
      );

      if (result.rowCount) auditInserted++; else alreadyDone++;

      // Reschedule detection: event contains "Inspection Date" and/or "Inspection Time"
      const newDate = parseIsnHistoryDate(event.changes["Inspection Date"]);
      const newTime = parseIsnHistoryTime(event.changes["Inspection Time"]);

      if ((newDate || newTime) && i > 0) {
        // Construct previous and new ISO datetimes (Pacific → UTC)
        if (prevScheduledDate && newDate && newDate !== prevScheduledDate) {
          const prevIso = `${prevScheduledDate}T${prevScheduledTime ?? "08:00"}:00-08:00`;
          const newIso = `${newDate}T${newTime ?? "08:00"}:00-08:00`;
          const prevAt = new Date(prevIso);
          const newAt = new Date(newIso);
          const initiatedBy = await lookupUserByIsnUid(event.uid, ACCOUNT_ID, systemUserId);

          await pool.query(
            `INSERT INTO reschedule_history
               (id, inspection_id, previous_scheduled_at, new_scheduled_at, reason, initiated_by, created_at)
             VALUES
               (gen_random_uuid(), $1, $2, $3, NULL, $4, $5)
             ON CONFLICT ON CONSTRAINT reschedule_history_unique_reschedule_idx DO NOTHING`,
            [row.id, prevAt.toISOString(), newAt.toISOString(), initiatedBy, createdAt.toISOString()]
          );
          rescheduleInserted++;
        }
      }

      // Update running state
      if (newDate) prevScheduledDate = newDate;
      if (newTime) prevScheduledTime = newTime;
    }
  }

  log("migrate-history", `Audit log: ${auditInserted} inserted, ${alreadyDone} already done`);
  log("migrate-history", `Reschedule history: ${rescheduleInserted} rows inserted`);
  await pool.end();
}

main().catch((err) => {
  logError("migrate-history", "Fatal", err);
  process.exit(1);
});
