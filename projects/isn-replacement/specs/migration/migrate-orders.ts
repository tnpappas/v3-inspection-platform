/**
 * migrate-orders.ts — Step 4: Order migration (inspections).
 *
 * The largest script. Applies the order class filter, pulls detail from ISN,
 * maps all 97+ fields per spec 04, and upserts to inspections. Idempotent via
 * isnSourceId upsert pattern. Handles line items, participants, and creates
 * the archived-cancellations.csv for older cancelled orders.
 *
 * Run: npx tsx specs/migration/migrate-orders.ts
 * Requires: MIGRATION_ACCOUNT_ID, MIGRATION_SAFEHOUSE_BIZ_ID env vars.
 * Output: migration/archived-cancellations.csv (gitignored, PII)
 *         migration/dropped-scripts.csv (gitignored)
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import {
  pool,
  log,
  logError,
  isnGet,
  isnGetThrottled,
  parseIsnDatetime,
  coerceIsnBoolean,
  normalizeIsnString,
  deriveStatusFromIsnOrder,
  derivePaymentStatusFromIsn,
  deriveSignatureStatusFromIsn,
  deriveSourceFromIsnOrder,
  parseIsnControls,
  ON_HOLD_PLACEHOLDER_AT,
  ISNOrderDetail,
  writeCsvHeader,
  writeCsvLine,
} from "./helpers";
import {
  inspections,
  inspectionServices,
  inspectionParticipants,
  inspectionInspectors,
} from "../01-schema";

const db = drizzle(pool, {
  schema: { inspections, inspectionServices, inspectionParticipants, inspectionInspectors },
});

const ARCHIVE_CSV = "migration/archived-cancellations.csv";
const SCRIPTS_CSV = "migration/dropped-scripts.csv";

/** Cut-off date for cancellation archiving. */
function getCancellationCutoff(): Date {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  return cutoff;
}

/** Returns true if this order should be imported into v3 inspections. */
function shouldImportOrder(
  order: ISNOrderDetail,
  cutoff: Date,
  threeYearsAgo: Date
): { import: boolean; archive: boolean; skip: boolean; reason: string } {
  const deletedAt = order.deleteddatetime
    ? parseIsnDatetime(order.deleteddatetime as string)
    : null;

  // Cancelled older than 6 months → archive CSV, skip import
  if (deletedAt && deletedAt < cutoff) {
    return { import: false, archive: true, skip: false, reason: "cancelled > 6 months ago" };
  }

  // Test/placeholder heuristic (open question #1 in spec 05)
  const totalFee = parseFloat((order.totalfee as string) ?? "0");
  const sqft = parseInt((order.squarefeet as string) ?? "0", 10);
  if (!order.client && totalFee === 0 && sqft === 0) {
    return { import: false, archive: false, skip: true, reason: "test/placeholder (no client, $0, 0 sqft)" };
  }

  return { import: true, archive: false, skip: false, reason: "qualifying order" };
}

async function lookupUserByIsnId(isnId: string | null | undefined, accountId: string): Promise<string | null> {
  if (!isnId) return null;
  const rows = await pool.query(
    `SELECT id FROM users WHERE account_id = $1 AND isn_source_id = $2 LIMIT 1`,
    [accountId, isnId]
  );
  return rows.rows[0]?.id ?? null;
}

async function lookupCustomerByIsnId(isnId: string | null | undefined, accountId: string): Promise<string | null> {
  if (!isnId) return null;
  const rows = await pool.query(
    `SELECT id FROM customers WHERE account_id = $1 AND isn_source_id = $2 LIMIT 1`,
    [accountId, isnId]
  );
  return rows.rows[0]?.id ?? null;
}

async function lookupParticipantByIsnId(isnId: string | null | undefined, accountId: string): Promise<string | null> {
  if (!isnId) return null;
  const rows = await pool.query(
    `SELECT id FROM transaction_participants WHERE account_id = $1 AND isn_source_id = $2 LIMIT 1`,
    [accountId, isnId]
  );
  return rows.rows[0]?.id ?? null;
}

async function lookupPropertyByAddress(
  address1: string, city: string, state: string, zip: string, accountId: string
): Promise<string | null> {
  const rows = await pool.query(
    `SELECT id FROM properties
     WHERE account_id = $1
       AND lower(trim(address1)) = lower(trim($2))
       AND lower(trim(city)) = lower(trim($3))
       AND lower(trim(state)) = lower(trim($4))
       AND lower(trim(zip)) = lower(trim($5))
     LIMIT 1`,
    [accountId, address1, city, state, zip]
  );
  return rows.rows[0]?.id ?? null;
}

async function lookupServiceByIsnId(isnId: string, bizId: string): Promise<string | null> {
  const rows = await pool.query(
    `SELECT id FROM services WHERE business_id = $1 AND isn_source_id = $2 LIMIT 1`,
    [bizId, isnId]
  );
  return rows.rows[0]?.id ?? null;
}

async function nextOrderNumber(businessSlug: string, year: number): Promise<string> {
  const seqName = `order_number_seq_${businessSlug.replace(/-/g, "_")}`;
  const rows = await pool.query(`SELECT nextval('${seqName}') AS n`);
  const seq = String(rows.rows[0].n).padStart(6, "0");
  const prefix = businessSlug === "safehouse" ? "SH" : businessSlug === "hcj-pools" ? "HCJ" : "PH";
  return `${prefix}-${year}-${seq}`;
}

async function main() {
  log("migrate-orders", "Starting order migration");

  const ACCOUNT_ID = process.env.MIGRATION_ACCOUNT_ID;
  const SAFEHOUSE_BIZ_ID = process.env.MIGRATION_SAFEHOUSE_BIZ_ID;
  if (!ACCOUNT_ID || !SAFEHOUSE_BIZ_ID) {
    throw new Error("Set MIGRATION_ACCOUNT_ID and MIGRATION_SAFEHOUSE_BIZ_ID env vars");
  }

  const systemEmail = `system@${process.env.SEED_ACCOUNT_SLUG ?? "pappas"}.local`;
  const sysRows = await pool.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [systemEmail]);
  const systemUserId = sysRows.rows[0]?.id;
  if (!systemUserId) throw new Error("System user not found. Run seed.ts first.");

  const cutoff = getCancellationCutoff();
  const threeYearsAgo = new Date();
  threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);

  writeCsvHeader(ARCHIVE_CSV, [
    "isn_order_id", "order_number", "deleted_at", "deleted_by_isn_uid",
    "scheduled_at", "customer_isn_id", "property_address", "property_zip",
    "fee_amount", "ordertype_name", "inspector1_isn_uid",
  ]);
  writeCsvHeader(SCRIPTS_CSV, [
    "isn_order_id", "control_name", "reason",
  ]);

  // Pull all order stubs
  log("migrate-orders", "Pulling order stubs from ISN...");
  const openResp = await isnGet<{ orders: Array<{ id: string }> }>("/orders?completed=false");
  const compResp = await isnGet<{ orders: Array<{ id: string }> }>("/orders?completed=true");
  const allStubs = [...openResp.orders, ...compResp.orders];

  // Deduplicate stubs (same order may appear in both lists)
  const uniqueIds = [...new Set(allStubs.map((s) => s.id))];
  log("migrate-orders", `Total unique order stubs: ${uniqueIds.length}`);

  let imported = 0, updated = 0, archived = 0, skipped = 0;

  for (const isnOrderId of uniqueIds) {
    const detailResp = await isnGetThrottled<{ order: ISNOrderDetail }>(
      `/order/${isnOrderId}?withallcontrols=true&withpropertyphoto=false`
    ).catch(() => null);
    if (!detailResp?.order) { skipped++; continue; }

    const order = detailResp.order;
    const { import: shouldImport, archive, skip, reason } = shouldImportOrder(order, cutoff, threeYearsAgo);

    if (archive) {
      writeCsvLine(ARCHIVE_CSV, {
        isn_order_id: order.id,
        order_number: String(order.oid ?? ""),
        deleted_at: String(order.deleteddatetime ?? ""),
        deleted_by_isn_uid: String(order.deletedby ?? ""),
        scheduled_at: String(order.datetime ?? ""),
        customer_isn_id: String(order.client ?? ""),
        property_address: `${order.address1 ?? ""}, ${order.city ?? ""} ${order.stateabbreviation ?? ""} ${order.zip ?? ""}`,
        property_zip: String(order.zip ?? ""),
        fee_amount: String(order.totalfee ?? ""),
        ordertype_name: String(order.ordertype ?? ""),
        inspector1_isn_uid: String(order.inspector1 ?? ""),
      });
      archived++;
      continue;
    }
    if (skip) { skipped++; continue; }

    // Resolve foreign keys
    const leadInspectorId = await lookupUserByIsnId(order.inspector1 as string, ACCOUNT_ID);
    const customerId = await lookupCustomerByIsnId(order.client as string, ACCOUNT_ID);
    const propertyId = order.address1
      ? await lookupPropertyByAddress(
          normalizeIsnString(order.address1 as string) ?? "",
          normalizeIsnString(order.city as string) ?? "",
          normalizeIsnString(order.stateabbreviation as string) ?? "",
          normalizeIsnString(order.zip as string) ?? "",
          ACCOUNT_ID
        )
      : null;

    // Parse custom fields
    const { customFields, scriptsDropped } = parseIsnControls(
      (order.controls as Array<{ name?: string; label?: string; value?: string }>) ?? []
    );
    for (const dropped of scriptsDropped) {
      writeCsvLine(SCRIPTS_CSV, { isn_order_id: order.id, control_name: dropped.name, reason: dropped.reason });
    }

    // Online scheduler enrichment
    if (coerceIsnBoolean(order.osorder as string) && order.osscheduleddatetime) {
      customFields["online_scheduled_at"] = parseIsnDatetime(order.osscheduleddatetime as string)?.toISOString() ?? null;
    }
    if (order.costcentername) {
      customFields["territory"] = order.costcentername;
    }

    // Derive scheduled_at
    const rawDatetime = order.datetime as string | null;
    const scheduledAtDate = rawDatetime && rawDatetime !== "No Date"
      ? parseIsnDatetime(rawDatetime)
      : null;
    const scheduledAt = scheduledAtDate ?? ON_HOLD_PLACEHOLDER_AT;

    // Derive status
    const status = deriveStatusFromIsnOrder(order);
    const paymentStatus = derivePaymentStatusFromIsn(order);
    const signatureStatus = deriveSignatureStatusFromIsn(order);
    const source = deriveSourceFromIsnOrder(order);

    const year = scheduledAtDate?.getFullYear() ?? new Date().getFullYear();

    // Upsert inspection
    const existing = await db.query.inspections?.findFirst({
      where: (i, { and, eq }) => and(
        eq(i.businessId, SAFEHOUSE_BIZ_ID),
        eq(i.isnSourceId, order.id)
      ),
    });

    let v3InspectionId: string;
    if (existing) {
      await db.update(inspections).set({
        status,
        paymentStatus,
        signatureStatus,
        scheduledAt,
        durationMinutes: Number(order.duration ?? 120),
        feeAmount: String(order.totalfee ?? "0"),
        leadInspectorId: leadInspectorId ?? undefined,
        customerId: customerId ?? undefined,
        propertyId: propertyId ?? undefined,
        customFields,
        cancelledAt: order.deleteddatetime ? parseIsnDatetime(order.deleteddatetime as string) : undefined,
        confirmedAt: order.confirmeddatetime ? parseIsnDatetime(order.confirmeddatetime as string) : undefined,
        initialCompletedAt: order.initialcompleteddatetime ? parseIsnDatetime(order.initialcompleteddatetime as string) : undefined,
        completedAt: order.completeddatetime ? parseIsnDatetime(order.completeddatetime as string) : undefined,
        updatedBy: systemUserId,
      }).where(eq(inspections.id, existing.id));
      v3InspectionId = existing.id;
      updated++;
    } else {
      const orderNumber = await nextOrderNumber("safehouse", year);
      const [created] = await db.insert(inspections).values({
        businessId: SAFEHOUSE_BIZ_ID,
        orderNumber,
        isnSourceId: order.id,
        isnReportNumber: order.reportnumber as string ?? null,
        scheduledAt,
        durationMinutes: Number(order.duration ?? 120),
        status,
        paymentStatus,
        signatureStatus,
        qaStatus: "not_reviewed",
        reportReleased: false,
        feeAmount: String(order.totalfee ?? "0"),
        leadInspectorId: leadInspectorId ?? null,
        customerId: customerId ?? null,
        propertyId: propertyId ?? null,
        customFields,
        source,
        cancelledAt: order.deleteddatetime ? parseIsnDatetime(order.deleteddatetime as string) : null,
        cancelledBy: order.deletedby ? await lookupUserByIsnId(order.deletedby as string, ACCOUNT_ID) : null,
        confirmedAt: order.confirmeddatetime ? parseIsnDatetime(order.confirmeddatetime as string) : null,
        initialCompletedAt: order.initialcompleteddatetime ? parseIsnDatetime(order.initialcompleteddatetime as string) : null,
        completedAt: order.completeddatetime ? parseIsnDatetime(order.completeddatetime as string) : null,
        rescheduleCount: 0,
        createdBy: systemUserId,
        updatedBy: systemUserId,
      }).returning();
      v3InspectionId = created.id;
      imported++;
    }

    // Inspection participants (buyer agent, listing agent)
    for (const [isnField, role] of [["buyersagent", "buyer_agent"], ["sellersagent", "listing_agent"]] as const) {
      const participantIsnId = order[isnField] as string | null;
      if (!participantIsnId) continue;
      const participantId = await lookupParticipantByIsnId(participantIsnId, ACCOUNT_ID);
      if (!participantId) continue;
      await db.insert(inspectionParticipants).values({
        inspectionId: v3InspectionId,
        participantId,
        roleInTransaction: role,
      }).onConflictDoNothing();
    }

    // Secondary inspectors (inspector2, inspector3)
    for (const slot of [2, 3]) {
      const isnInspectorId = order[`inspector${slot}`] as string | null;
      if (!isnInspectorId) continue;
      const inspectorId = await lookupUserByIsnId(isnInspectorId, ACCOUNT_ID);
      if (!inspectorId) continue;
      await db.insert(inspectionInspectors).values({
        inspectionId: v3InspectionId,
        inspectorId,
        role: "secondary",
        assignedBy: systemUserId,
      }).onConflictDoNothing();
    }

    // Fees → inspection_services line items
    const fees = (order.fees as Array<{ id: string; amount: string | number; outsourceamount?: string; name?: string }>) ?? [];
    for (const fee of fees) {
      const amt = parseFloat(String(fee.amount ?? 0));
      if (amt === 0) continue;
      const serviceId = await lookupServiceByIsnId(fee.id, SAFEHOUSE_BIZ_ID);
      if (!serviceId) continue;
      await db.insert(inspectionServices).values({
        inspectionId: v3InspectionId,
        serviceId,
        fee: String(amt),
      }).onConflictDoNothing();
    }
  }

  log("migrate-orders", `Done. Imported: ${imported}, Updated: ${updated}, Archived: ${archived}, Skipped: ${skipped}`);
  log("migrate-orders", `Archive CSV: ${ARCHIVE_CSV}`);
  await pool.end();
}

main().catch((err) => {
  logError("migrate-orders", "Fatal", err);
  process.exit(1);
});
