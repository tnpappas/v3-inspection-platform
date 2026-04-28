/**
 * migrate-services.ts — Step 0.5: Import ISN services as v3 services.
 *
 * Phase 4 update: now uses the undocumented /services endpoint (20 rich records)
 * as the primary source instead of /ordertypes (stub-level data only). Falls back
 * to /ordertypes for any ordertype not present in /services.
 *
 * Fields added in v3.1.3: isnSid, ancillary, visibleToDispatcher, visibleOnlineBooking,
 * isPac, modifiers, questions.
 *
 * Runs after seed.ts (needs business IDs) and before migrate-orders.ts.
 * Idempotent via isnSourceId upsert.
 *
 * Run: npx tsx specs/migration/migrate-services.ts
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import {
  pool,
  log,
  logError,
  isnGet,
  coerceIsnBoolean,
  normalizeIsnString,
  defaultDurationForBusinessType,
  PerAccountConfig,
} from "./helpers";
import { services } from "../01-schema";

const db = drizzle(pool, { schema: { services } });

interface ISNOrdertype {
  id: string;
  name: string;
  description?: string;
  publicdescription?: string;
  sequence?: number;
  show?: string;
  modified?: string;
}

/** Phase 4: rich service record from undocumented /services endpoint */
interface ISNService {
  id: string;                    // UUID (same as isnSourceId)
  sid: number;                   // ISN stable integer SID
  office: string;
  name: string;
  privatename?: string;
  inspectiontypeid?: string;     // UUID of associated ordertype
  inspectiontype?: {             // embedded ordertype object
    id: string;
    _id: number;
    name: string;
    description?: string;
    publicdescription?: string;
    sequence?: number;
    fee?: string;
    show?: string;
  };
  label?: string;
  modifiers?: unknown[];          // price modifier rules; no samples observed
  ancillary: string;             // 'Yes'|'No' (ISN string boolean)
  visible: string;               // 'Yes'|'No' — visible to dispatcher
  visible_order_form: string;    // 'Yes'|'No' — visible on online booking
  sequence?: number;
  is_pac: string;                // 'Yes'|'No' — Pay-at-Close flag
  description?: string;
  perceptionist_name?: string;
  questions?: Array<{ id: string; type: 'boolean' | 'text'; question: string }>;
}

interface ISNFeeRow {
  id: string;
  name: string;
  amount?: string | number;
  outsourceamount?: string;
}

/** Ordertypes to skip entirely (not imported as services). */
function shouldSkipOrdertype(name: string): boolean {
  return (
    /please don't use/i.test(name) ||
    /\*{4,}/.test(name) // warning-row patterns like "***...**"
  );
}

async function main() {
  log("migrate-services", "Starting services migration");

  const SAFEHOUSE_BIZ_ID = process.env.MIGRATION_SAFEHOUSE_BIZ_ID;
  if (!SAFEHOUSE_BIZ_ID) {
    throw new Error("Set MIGRATION_SAFEHOUSE_BIZ_ID env var");
  }

  const systemEmail = `system@${process.env.SEED_ACCOUNT_SLUG ?? "pappas"}.local`;
  const sysRows = await pool.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [systemEmail]);
  const systemUserId = sysRows.rows[0]?.id;
  if (!systemUserId) throw new Error("System user not found. Run seed.ts first.");

  const config: PerAccountConfig = { accountSlug: process.env.SEED_ACCOUNT_SLUG ?? "pappas" };
  const defaultDuration = defaultDurationForBusinessType("inspection", config);

  // ---- Step 1: Pull ISN /services (Phase 4: undocumented endpoint, rich data) ----
  let isnServices: ISNService[] = [];
  try {
    const svcResp = await isnGet<{ services: ISNService[] }>("/services");
    isnServices = svcResp.services ?? [];
    log("migrate-services", `Pulled ${isnServices.length} services from /services (undocumented endpoint)`);
  } catch (err) {
    log("migrate-services", `WARNING: /services endpoint unavailable (${err}). Will fall back to /ordertypes only.`);
  }

  // Also pull ordertypes for any entries not in /services
  const resp = await isnGet<{ ordertypes: ISNOrdertype[] }>("/ordertypes/");
  const ordertypes = resp.ordertypes;
  log("migrate-services", `Pulled ${ordertypes.length} ordertypes from /ordertypes/`);

  // Build lookup: inspectiontypeid → ISNService (from /services)
  const serviceByInspectionTypeId = new Map<string, ISNService>();
  const serviceByUUID = new Map<string, ISNService>();
  for (const svc of isnServices) {
    if (svc.inspectiontypeid) serviceByInspectionTypeId.set(svc.inspectiontypeid, svc);
    serviceByUUID.set(svc.id, svc);
  }

  let imported = 0, updated = 0, skipped = 0;

  // ---- Step 1a: Upsert from /services (rich records) ----
  for (const svc of isnServices) {
    const name = normalizeIsnString(svc.name) ?? "Unknown Service";
    if (shouldSkipOrdertype(name)) { skipped++; continue; }

    // Determine active: use inspectiontype.show if available, else visible
    const active = coerceIsnBoolean(svc.inspectiontype?.show ?? svc.visible) ?? true;

    const payload = {
      businessId: SAFEHOUSE_BIZ_ID,
      name,
      description: normalizeIsnString(svc.description) ?? null,
      publicDescription: null,
      category: svc.ancillary === "Yes" ? "add-on" : "primary",
      baseFee: "0.00",
      defaultDurationMinutes: defaultDuration,
      sequence: svc.sequence ?? 100,
      active,
      isnSourceId: svc.id,
      // v3.1.3 new fields
      isnSid: svc.sid,
      ancillary: svc.ancillary === "Yes",
      visibleToDispatcher: svc.visible === "Yes",
      visibleOnlineBooking: svc.visible_order_form === "Yes",
      isPac: svc.is_pac === "Yes",
      modifiers: svc.modifiers && svc.modifiers.length > 0 ? svc.modifiers : null,
      questions: svc.questions && svc.questions.length > 0 ? svc.questions : null,
      createdBy: systemUserId,
      lastModifiedBy: systemUserId,
    };

    const existing = await db.query.services?.findFirst({
      where: (s, { and, eq }) => and(eq(s.businessId, SAFEHOUSE_BIZ_ID), eq(s.isnSourceId, svc.id)),
    });

    if (existing) {
      await db.update(services).set(payload).where(eq(services.id, existing.id));
      updated++;
    } else {
      await db.insert(services).values(payload);
      imported++;
    }
  }

  // ---- Step 1b: Upsert ordertypes NOT covered by /services ----
  for (const ot of ordertypes) {
    const name = normalizeIsnString(ot.name) ?? "Unknown Service";
    if (shouldSkipOrdertype(name)) { skipped++; continue; }
    if (serviceByInspectionTypeId.has(ot.id)) continue; // already imported via /services

    const active = coerceIsnBoolean(ot.show);
    const description = normalizeIsnString(ot.description) ?? null;
    const payload = {
      businessId: SAFEHOUSE_BIZ_ID,
      name,
      description,
      publicDescription: normalizeIsnString(ot.publicdescription) ?? null,
      baseFee: "0.00",
      defaultDurationMinutes: defaultDuration,
      sequence: ot.sequence ?? 100,
      active,
      isnSourceId: ot.id,
      ancillary: false,
      visibleToDispatcher: true,
      visibleOnlineBooking: false,
      isPac: false,
      createdBy: systemUserId,
      lastModifiedBy: systemUserId,
    };

    const existing = await db.query.services?.findFirst({
      where: (s, { and, eq }) => and(eq(s.businessId, SAFEHOUSE_BIZ_ID), eq(s.isnSourceId, ot.id)),
    });

    if (existing) {
      await db.update(services).set(payload).where(eq(services.id, existing.id));
      updated++;
    } else {
      await db.insert(services).values(payload);
      imported++;
    }
  }

  log("migrate-services", `Services: ${imported} imported, ${updated} updated, ${skipped} skipped`);

  // ---- Step 2: Pull fee catalog from a sample order ----
  // The fees[] array on orders contains 25 fixed rows with stable ISN UUIDs.
  // These serve as the line-item service catalog for migrate-orders.ts.
  // We import them as services with isnSourceId = fee.id.
  // Base fee defaults to 0; the actual per-order fee comes from inspection_services.fee.
  //
  // Pull from discovery/raw/phase2 pilot if available, else skip.
  try {
    const { execSync } = require("child_process");
    const pilotFiles = execSync(
      "ls ~/.openclaw/workspace/projects/isn-replacement/discovery/raw/phase2/pilot-1-*.json 2>/dev/null || true"
    ).toString().trim().split("\n").filter(Boolean);

    if (pilotFiles.length === 0) {
      log("migrate-services", "No pilot order found; skipping fee catalog import. Fees will be imported on first order migration.");
      await pool.end();
      return;
    }

    const fs = require("fs");
    const pilotOrder = JSON.parse(fs.readFileSync(pilotFiles[0], "utf8")).order;
    const fees: ISNFeeRow[] = pilotOrder?.fees ?? [];
    log("migrate-services", `Importing ${fees.length} fee-catalog rows from pilot order`);

    let feeImported = 0, feeUpdated = 0;
    for (const fee of fees) {
      const feeName = normalizeIsnString(fee.name) ?? "Unknown Fee";

      const existing = await db.query.services?.findFirst({
        where: (s, { and, eq }) => and(
          eq(s.businessId, SAFEHOUSE_BIZ_ID),
          eq(s.isnSourceId, fee.id)
        ),
      });

      const feePayload = {
        businessId: SAFEHOUSE_BIZ_ID,
        name: feeName,
        description: `ISN fee catalog item`,
        publicDescription: null,
        baseFee: "0.00",
        defaultDurationMinutes: defaultDuration,
        sequence: 200, // After ordertypes
        active: true,
        isnSourceId: fee.id,
        createdBy: systemUserId,
        lastModifiedBy: systemUserId,
      };

      if (existing) {
        await db.update(services).set(feePayload).where(eq(services.id, existing.id));
        feeUpdated++;
      } else {
        await db.insert(services).values(feePayload);
        feeImported++;
      }
    }

    log("migrate-services", `Fee catalog: ${feeImported} imported, ${feeUpdated} updated`);
  } catch (err) {
    log("migrate-services", "Fee catalog import skipped (discovery files not available)");
  }

  log("migrate-services", "Services migration complete");
  await pool.end();
}

main().catch((err) => {
  logError("migrate-services", "Fatal", err);
  process.exit(1);
});
