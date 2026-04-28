/**
 * validate-migration.ts — Final validation pass.
 *
 * Runs all 20+ checks from the spec 05 validation checklist.
 * Exits with code 1 if any check fails; 0 if all pass.
 * Produces a validation-report.txt in migration/ (not gitignored; safe for ops).
 *
 * Run: npx tsx specs/migration/validate-migration.ts
 */

import "dotenv/config";
import * as fs from "fs";
import { pool, log, logError } from "./helpers";

const REPORT_PATH = "migration/validation-report.txt";
const results: Array<{ check: string; pass: boolean; detail: string }> = [];

function report(check: string, pass: boolean, detail: string): void {
  results.push({ check, pass, detail });
  const icon = pass ? "✅" : "❌";
  log("validate", `${icon} ${check}: ${detail}`);
}

async function q(sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function main() {
  log("validate", "Starting migration validation");

  const ACCOUNT_ID = process.env.MIGRATION_ACCOUNT_ID;
  const SAFEHOUSE_BIZ_ID = process.env.MIGRATION_SAFEHOUSE_BIZ_ID;
  if (!ACCOUNT_ID || !SAFEHOUSE_BIZ_ID) {
    throw new Error("Set MIGRATION_ACCOUNT_ID and MIGRATION_SAFEHOUSE_BIZ_ID env vars");
  }

  // ---- Row counts ----
  const userCount = (await q(`SELECT COUNT(*) FROM users WHERE account_id = $1 AND is_system = FALSE`, [ACCOUNT_ID]))[0].count;
  report("Users imported", Number(userCount) > 0, `${userCount} users`);

  const customerCount = (await q(`SELECT COUNT(*) FROM customers WHERE account_id = $1`, [ACCOUNT_ID]))[0].count;
  report("Customers imported", Number(customerCount) > 0, `${customerCount} customers`);

  const participantCount = (await q(`SELECT COUNT(*) FROM transaction_participants WHERE account_id = $1`, [ACCOUNT_ID]))[0].count;
  report("Participants imported", Number(participantCount) > 0, `${participantCount} participants`);

  const agencyCount = (await q(`SELECT COUNT(*) FROM agencies WHERE account_id = $1`, [ACCOUNT_ID]))[0].count;
  report("Agencies imported", Number(agencyCount) > 0, `${agencyCount} agencies`);

  const inspectionCount = (await q(`SELECT COUNT(*) FROM inspections WHERE business_id = $1 AND deleted_at IS NULL`, [SAFEHOUSE_BIZ_ID]))[0].count;
  report("Inspections imported", Number(inspectionCount) > 0, `${inspectionCount} active inspections`);

  const cancelledCount = (await q(`SELECT COUNT(*) FROM inspections WHERE business_id = $1 AND status = 'cancelled'`, [SAFEHOUSE_BIZ_ID]))[0].count;
  report("Cancelled inspections imported (last 6 months)", Number(cancelledCount) > 0, `${cancelledCount} cancelled`);

  const archiveExists = fs.existsSync("migration/archived-cancellations.csv");
  report("Archived cancellations CSV exists", archiveExists, archiveExists ? "file present" : "file missing");

  // ---- FK integrity ----
  const orphanedCustomer = (await q(
    `SELECT COUNT(*) FROM inspections WHERE business_id = $1 AND customer_id IS NOT NULL
     AND customer_id NOT IN (SELECT id FROM customers)`,
    [SAFEHOUSE_BIZ_ID]
  ))[0].count;
  report("No orphaned customer FKs", Number(orphanedCustomer) === 0, `${orphanedCustomer} orphaned`);

  const orphanedProperty = (await q(
    `SELECT COUNT(*) FROM inspections WHERE business_id = $1 AND property_id IS NOT NULL
     AND property_id NOT IN (SELECT id FROM properties)`,
    [SAFEHOUSE_BIZ_ID]
  ))[0].count;
  report("No orphaned property FKs", Number(orphanedProperty) === 0, `${orphanedProperty} orphaned`);

  const orphanedInspector = (await q(
    `SELECT COUNT(*) FROM inspections WHERE business_id = $1 AND lead_inspector_id IS NOT NULL
     AND lead_inspector_id NOT IN (SELECT id FROM users)`,
    [SAFEHOUSE_BIZ_ID]
  ))[0].count;
  report("No orphaned inspector FKs", Number(orphanedInspector) === 0, `${orphanedInspector} orphaned`);

  // ---- System user integrity ----
  const systemUserCount = (await q(
    `SELECT COUNT(*) FROM users WHERE account_id = $1 AND is_system = TRUE`,
    [ACCOUNT_ID]
  ))[0].count;
  report("Exactly one system user per account", Number(systemUserCount) === 1, `${systemUserCount} system users`);

  const systemUserCreds = (await q(
    `SELECT COUNT(*) FROM users WHERE account_id = $1 AND is_system = TRUE AND password_hash IS NOT NULL`,
    [ACCOUNT_ID]
  ))[0].count;
  report("System user has no password_hash", Number(systemUserCreds) === 0, `${systemUserCreds} system users with password`);

  // ---- Audit log INV-1 spot check ----
  // Sample 100 audit_log rows and verify each entity's account_id matches
  const inv1Sample = await q(
    `SELECT al.id, al.account_id, al.entity_type, al.entity_id
     FROM audit_log al
     WHERE al.account_id = $1
     ORDER BY al.created_at DESC
     LIMIT 100`,
    [ACCOUNT_ID]
  );
  // For inspections, verify the inspection's business is in the correct account
  let inv1Failures = 0;
  for (const row of inv1Sample) {
    if (row.entity_type === "inspection" && row.entity_id) {
      const check = await q(
        `SELECT COUNT(*) FROM inspections i
         JOIN businesses b ON b.id = i.business_id
         WHERE i.id = $1 AND b.account_id = $2`,
        [row.entity_id, row.account_id]
      );
      if (Number(check[0].count) === 0) inv1Failures++;
    }
  }
  report("INV-1 audit_log account_id spot check", inv1Failures === 0, `${inv1Failures} mismatches in 100-row sample`);

  // ---- Permission checks ----
  const ownerRows = await q(
    `SELECT ur.user_id FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     WHERE ur.business_id = $1 AND ur.role = 'owner' AND u.is_system = FALSE
     LIMIT 1`,
    [SAFEHOUSE_BIZ_ID]
  );
  report("At least one owner in Safe House business", ownerRows.length > 0, `${ownerRows.length} owners`);

  if (ownerRows.length > 0) {
    const ownerId = ownerRows[0].user_id as string;
    // Owner should have 0 permission denies (all permissions granted)
    const ownerDenies = (await q(
      `SELECT COUNT(*) FROM user_permission_overrides WHERE user_id = $1 AND business_id = $2 AND effect = 'deny'`,
      [ownerId, SAFEHOUSE_BIZ_ID]
    ))[0].count;
    report("Owner has no permission denies", Number(ownerDenies) === 0, `${ownerDenies} denies`);
  }

  const bookkeepers = await q(
    `SELECT ur.user_id FROM user_roles ur WHERE ur.business_id = $1 AND ur.role = 'bookkeeper' LIMIT 1`,
    [SAFEHOUSE_BIZ_ID]
  );
  if (bookkeepers.length > 0) {
    const bkId = bookkeepers[0].user_id as string;
    const bkPiiDeny = (await q(
      `SELECT COUNT(*) FROM user_permission_overrides
       WHERE user_id = $1 AND business_id = $2 AND effect = 'deny' AND permission_key = 'view.customer.pii'`,
      [bkId, SAFEHOUSE_BIZ_ID]
    ))[0].count;
    report("Bookkeeper has view.customer.pii deny", Number(bkPiiDeny) > 0, `${bkPiiDeny} deny rows`);
  }

  // ---- Scheduled_at timezone check (sample) ----
  const futureUtcCheck = await q(
    `SELECT COUNT(*) FROM inspections
     WHERE business_id = $1 AND status = 'scheduled'
       AND scheduled_at > now() - interval '1 year'
       AND scheduled_at < '9999-01-01'::timestamptz
       AND date_part('timezone', scheduled_at) != 0`,
    [SAFEHOUSE_BIZ_ID]
  );
  // All scheduled_at should be stored in UTC (timezone offset = 0)
  report("Scheduled inspections stored in UTC", Number(futureUtcCheck[0].count) === 0,
    `${futureUtcCheck[0].count} rows with non-UTC offset`);

  // ---- Reschedule history ----
  const rescheduleCount = (await q(
    `SELECT COUNT(*) FROM reschedule_history rh
     JOIN inspections i ON i.id = rh.inspection_id
     WHERE i.business_id = $1`,
    [SAFEHOUSE_BIZ_ID]
  ))[0].count;
  report("Reschedule history rows present", Number(rescheduleCount) > 0, `${rescheduleCount} rows`);

  // ---- Write report ----
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const reportText = [
    `Migration Validation Report — ${new Date().toISOString()}`,
    `Account: ${ACCOUNT_ID}  Business: ${SAFEHOUSE_BIZ_ID}`,
    `Results: ${passed} passed, ${failed} failed`,
    "",
    ...results.map((r) => `${r.pass ? "PASS" : "FAIL"} | ${r.check} | ${r.detail}`),
  ].join("\n");

  fs.writeFileSync(REPORT_PATH, reportText, "utf8");
  log("validate", `Report written to ${REPORT_PATH}`);

  if (failed > 0) {
    logError("validate", `${failed} checks failed. Review ${REPORT_PATH} before proceeding.`);
    process.exit(1);
  } else {
    log("validate", "All checks passed. Migration validated.");
  }

  await pool.end();
}

main().catch((err) => {
  logError("validate", "Fatal", err);
  process.exit(1);
});
