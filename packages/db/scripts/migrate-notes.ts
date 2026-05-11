/**
 * migrate-notes.ts — Step 4.5: Import ISN order notes into inspection_notes.
 *
 * Pulls /order/notes/{id} for every migrated inspection and inserts rows
 * into inspection_notes. Dispatcher notes (user = {id, display} object)
 * get note_type='dispatcher'. System notes (user = [] empty array) get
 * note_type='system'.
 *
 * This script runs AFTER migrate-orders.ts (needs inspection rows to exist)
 * and before validate-migration.ts.
 *
 * Idempotent: uses ON CONFLICT DO NOTHING on (inspection_id, created_at, content)
 * natural key. ISN notes have no stable ID; dedup is content+timestamp based.
 *
 * Run: npx tsx specs/migration/migrate-notes.ts
 * Requires: MIGRATION_ACCOUNT_ID, MIGRATION_SAFEHOUSE_BIZ_ID env vars.
 *
 * Phase 4 discovery: /order/notes/{id} is an undocumented ISN endpoint.
 * Response shape: { status, notes: [{temp, dte, user, text}], message }
 * - temp: boolean (temporary note — carry forward but flag)
 * - dte: datetime string in ISN local time (Pacific)
 * - user: {id: UUID, display: string} for dispatcher notes,
 *         [] (empty array) for system-generated notes
 * - text: note content string
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  pool,
  log,
  logError,
  isnGetThrottled,
  parseIsnDatetime,
  normalizeIsnString,
} from "./helpers";

// inspection_notes table (v3.1.3)
// Using raw SQL for this table since it's new and may not be in the Drizzle
// generated client yet at migration time. Switch to db.insert() once schema
// is applied to the target DB.
const db = drizzle(pool);

const BATCH_SIZE = 50;  // process in batches; log progress every N inspections

interface ISNNoteUser {
  id?: string;
  display?: string;
}

interface ISNNote {
  temp: boolean;
  dte: string;                           // ISN local time string
  user: ISNNoteUser | ISNNoteUser[];     // object for dispatcher; [] for system
  text: string;
}

async function lookupUserByIsnId(isnId: string | null | undefined, accountId: string): Promise<string | null> {
  if (!isnId) return null;
  const rows = await pool.query(
    `SELECT id FROM users WHERE account_id = $1 AND isn_source_id = $2 LIMIT 1`,
    [accountId, isnId]
  );
  return rows.rows[0]?.id ?? null;
}

async function main() {
  log("migrate-notes", "Starting inspection notes migration");

  const ACCOUNT_ID = process.env.MIGRATION_ACCOUNT_ID;
  const SAFEHOUSE_BIZ_ID = process.env.MIGRATION_SAFEHOUSE_BIZ_ID;
  if (!ACCOUNT_ID || !SAFEHOUSE_BIZ_ID) {
    throw new Error("Set MIGRATION_ACCOUNT_ID and MIGRATION_SAFEHOUSE_BIZ_ID env vars");
  }

  // Pull all migrated inspections with their ISN source IDs
  const rows = await pool.query<{ id: string; isn_source_id: string }>(
    `SELECT id, isn_source_id FROM inspections
     WHERE business_id = $1
       AND isn_source_id IS NOT NULL
     ORDER BY created_at`,
    [SAFEHOUSE_BIZ_ID]
  );
  const inspectionRows = rows.rows;
  log("migrate-notes", `Processing notes for ${inspectionRows.length} inspections`);

  let totalInserted = 0;
  let totalFailed = 0;
  let totalEmpty = 0;
  let processed = 0;

  for (const insp of inspectionRows) {
    const { id: v3InspectionId, isn_source_id: isnOrderId } = insp;

    // Pull notes from ISN (throttled)
    const resp = await isnGetThrottled<{ notes?: ISNNote[]; status: string }>(
      `/order/notes/${isnOrderId}`
    ).catch((err) => {
      logError("migrate-notes", `Failed to pull notes for ISN order ${isnOrderId}`, err);
      return null;
    });

    if (!resp?.notes || resp.notes.length === 0) {
      totalEmpty++;
    } else {
      for (const note of resp.notes) {
        const content = normalizeIsnString(note.text);
        if (!content) continue; // skip blank notes

        // Determine note type and author
        const userObj = Array.isArray(note.user) ? null : note.user as ISNNoteUser;
        const isnAuthorId = userObj?.id ?? null;
        const authorId = isnAuthorId
          ? await lookupUserByIsnId(isnAuthorId, ACCOUNT_ID)
          : null;

        const noteType = userObj?.id ? "dispatcher" : "system";
        const createdAt = parseIsnDatetime(note.dte) ?? new Date();

        // is_internal: dispatcher notes visible to staff; system notes flagged internal by default
        // After migration, office staff can review and adjust visibility per note
        const isInternal = noteType === "system";

        try {
          await pool.query(
            `INSERT INTO inspection_notes
               (id, inspection_id, author_id, note_type, content, is_internal, created_at)
             VALUES
               (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [v3InspectionId, authorId, noteType, content, isInternal, createdAt]
          );
          totalInserted++;
        } catch (err) {
          logError("migrate-notes", `Failed to insert note for inspection ${v3InspectionId}`, err);
          totalFailed++;
        }
      }
    }

    processed++;
    if (processed % BATCH_SIZE === 0) {
      log("migrate-notes", `Progress: ${processed}/${inspectionRows.length} inspections, ${totalInserted} notes inserted`);
    }
  }

  log(
    "migrate-notes",
    `Done. ${totalInserted} notes inserted, ${totalFailed} failed, ${totalEmpty} inspections had no notes. ` +
    `Processed ${processed} inspections.`
  );
  await pool.end();
}

main().catch((err) => {
  logError("migrate-notes", "Fatal", err);
  process.exit(1);
});
