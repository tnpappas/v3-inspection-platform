/**
 * migrate-services.ts — Step 0.5: Import ISN ordertypes as v3 services.
 *
 * Runs after seed.ts (needs business IDs) and before migrate-orders.ts
 * (orders reference services via line items). Idempotent via isnSourceId upsert.
 *
 * Also imports ISN fee catalog (25 fixed fee rows from order.fees[]) as
 * additional services for line-item matching.
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

  // ---- Step 1: Pull ISN ordertypes ----
  const resp = await isnGet<{ ordertypes: ISNOrdertype[] }>("/ordertypes/");
  const ordertypes = resp.ordertypes;
  log("migrate-services", `Pulled ${ordertypes.length} ordertypes from ISN`);

  let imported = 0, updated = 0, skipped = 0;

  for (const ot of ordertypes) {
    const name = normalizeIsnString(ot.name) ?? "Unknown Service";

    if (shouldSkipOrdertype(name)) {
      log("migrate-services", `Skipping warning row: "${name}"`);
      skipped++;
      continue;
    }

    const active = coerceIsnBoolean(ot.show);
    const description = normalizeIsnString(ot.description) ?? null;
    // Tag duplicates: ISN has multiple "Reinspection" rows — mark older inactive ones
    const isDuplicate = !active && name === normalizeIsnString(ot.name);

    const payload = {
      businessId: SAFEHOUSE_BIZ_ID,
      name,
      description: isDuplicate ? `[duplicate, retired] ${description ?? ""}`.trim() : description,
      publicDescription: normalizeIsnString(ot.publicdescription) ?? null,
      baseFee: "0.00", // ISN ordertypes have no fee; fee comes from the order's fees[] array
      defaultDurationMinutes: defaultDuration,
      sequence: ot.sequence ?? 100,
      active,
      isnSourceId: ot.id,
      createdBy: systemUserId,
      lastModifiedBy: systemUserId,
    };

    const existing = await db.query.services?.findFirst({
      where: (s, { and, eq }) => and(
        eq(s.businessId, SAFEHOUSE_BIZ_ID),
        eq(s.isnSourceId, ot.id)
      ),
    });

    if (existing) {
      await db.update(services).set(payload).where(eq(services.id, existing.id));
      updated++;
    } else {
      await db.insert(services).values(payload);
      imported++;
    }
  }

  log("migrate-services", `Ordertypes: ${imported} imported, ${updated} updated, ${skipped} skipped`);

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
