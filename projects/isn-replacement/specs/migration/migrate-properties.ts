/**
 * migrate-properties.ts — Step 3: Property import.
 *
 * Extracts unique properties from ISN order data (loaded from local raw
 * discovery files to avoid re-pulling from the API). Deduplicates by address,
 * inserts properties and property_businesses junctions.
 * Idempotent via propertyDedupeKey lookup.
 *
 * NOTE: For a full migration, this script must be run AFTER the orders have
 * been pulled from ISN (via the full order crawl, not just the 15 pilot
 * samples in discovery/raw/phase2). During migration prep, pull all qualifying
 * orders to a local JSON file and point ORDERS_FILE at it.
 *
 * Run: npx tsx specs/migration/migrate-properties.ts
 * Requires: ORDERS_FILE env var pointing at the full orders JSON dump.
 * Output: migration/property-dedup.csv (gitignored)
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import * as fs from "fs";
import {
  pool,
  log,
  logError,
  normalizeIsnString,
  propertyDedupeKey,
  writeCsvHeader,
  writeCsvLine,
  ISNOrderDetail,
} from "./helpers";
import { properties, propertyBusinesses } from "../01-schema";

const db = drizzle(pool, { schema: { properties, propertyBusinesses } });

const DEDUP_CSV = "migration/property-dedup.csv";

/** ISN foundation UUID → controlled vocabulary string.
 * Built from the one-time foundation lookup pull during migration prep.
 * Populate this map before running the full migration.
 */
const FOUNDATION_MAP: Record<string, string> = {
  // Example entries — populate from ISN API during migration prep
  // "5d8fbc5c-b2d3-4319-9610-ed962af3f25d": "slab",
  // Add all foundation UUIDs observed in the data
};

export function translateIsnFoundation(uuid: string | null | undefined): string | null {
  if (!uuid) return null;
  return FOUNDATION_MAP[uuid] ?? null; // null = unknown; staff reviews post-migration
}

interface OrderPropertyFields {
  isnOrderId: string;
  address1?: string;
  address2?: string;
  city?: string;
  stateabbreviation?: string;
  zip?: string;
  county?: string;
  latitude?: number;
  longitude?: number;
  yearbuilt?: string;
  squarefeet?: string;
  foundation?: string;
  propertyoccupied?: string;
}

function extractPropertyFromOrder(order: ISNOrderDetail): OrderPropertyFields {
  return {
    isnOrderId: order.id,
    address1: normalizeIsnString(order.address1 as string) ?? undefined,
    address2: normalizeIsnString(order.address2 as string) ?? undefined,
    city: normalizeIsnString(order.city as string) ?? undefined,
    stateabbreviation: normalizeIsnString(order.stateabbreviation as string) ?? undefined,
    zip: normalizeIsnString(order.zip as string) ?? undefined,
    county: normalizeIsnString(order.county as string) ?? undefined,
    latitude: order.latitude as number | undefined,
    longitude: order.longitude as number | undefined,
    yearbuilt: order.yearbuilt as string | undefined,
    squarefeet: order.squarefeet as string | undefined,
    foundation: order.foundation as string | undefined,
    propertyoccupied: order.propertyoccupied as string | undefined,
  };
}

async function main() {
  log("migrate-properties", "Starting property migration");

  const ACCOUNT_ID = process.env.MIGRATION_ACCOUNT_ID;
  const SAFEHOUSE_BIZ_ID = process.env.MIGRATION_SAFEHOUSE_BIZ_ID;
  const ORDERS_FILE = process.env.ORDERS_FILE;

  if (!ACCOUNT_ID || !SAFEHOUSE_BIZ_ID) {
    throw new Error("Set MIGRATION_ACCOUNT_ID and MIGRATION_SAFEHOUSE_BIZ_ID");
  }
  if (!ORDERS_FILE || !fs.existsSync(ORDERS_FILE)) {
    throw new Error(`ORDERS_FILE not found: ${ORDERS_FILE ?? "(not set)"}. Pull full orders during migration prep.`);
  }

  writeCsvHeader(DEDUP_CSV, [
    "dedup_key", "first_order_id", "duplicate_order_ids", "v3_property_id",
  ]);

  const orders: ISNOrderDetail[] = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  log("migrate-properties", `Loaded ${orders.length} orders from ${ORDERS_FILE}`);

  // Group orders by dedup key
  const byDedup = new Map<string, OrderPropertyFields[]>();
  for (const order of orders) {
    const p = extractPropertyFromOrder(order);
    if (!p.address1 || !p.city || !p.stateabbreviation || !p.zip) continue;
    const key = propertyDedupeKey({
      address1: p.address1,
      city: p.city,
      state: p.stateabbreviation,
      zip: p.zip,
    });
    if (!byDedup.has(key)) byDedup.set(key, []);
    byDedup.get(key)!.push(p);
  }

  log("migrate-properties", `Unique properties after dedup: ${byDedup.size} (from ${orders.length} orders)`);

  let inserted = 0, alreadyExisted = 0;

  for (const [key, group] of byDedup) {
    // Use the most-complete record as canonical (most non-null fields)
    const canonical = group.sort(
      (a, b) => Object.values(b).filter(Boolean).length - Object.values(a).filter(Boolean).length
    )[0];

    if (group.length > 1) {
      writeCsvLine(DEDUP_CSV, {
        dedup_key: key,
        first_order_id: canonical.isnOrderId,
        duplicate_order_ids: group.slice(1).map((g) => g.isnOrderId).join(";"),
        v3_property_id: "", // filled in below
      });
    }

    // Check for existing (by address dedup key stored in... we do a live query)
    // Since we don't have an isnSourceId on properties, we query by the dedup key fields.
    const existingRows = await db.execute(
      `SELECT id FROM properties
       WHERE account_id = '${ACCOUNT_ID}'
         AND lower(trim(address1)) = lower(trim('${(canonical.address1 ?? "").replace(/'/g, "''")}'))
         AND lower(trim(city)) = lower(trim('${(canonical.city ?? "").replace(/'/g, "''")}'))
         AND lower(trim(state)) = lower(trim('${(canonical.stateabbreviation ?? "").replace(/'/g, "''")}'))
         AND lower(trim(zip)) = lower(trim('${(canonical.zip ?? "").replace(/'/g, "''")}'))
       LIMIT 1`
    ) as { rows: Array<{ id: string }> };

    if (existingRows.rows.length > 0) {
      alreadyExisted++;
      continue;
    }

    const [created] = await db.insert(properties).values({
      accountId: ACCOUNT_ID,
      address1: canonical.address1!,
      address2: canonical.address2 ?? null,
      city: canonical.city!,
      state: canonical.stateabbreviation!,
      zip: canonical.zip!,
      county: canonical.county ?? null,
      latitude: canonical.latitude ? String(canonical.latitude) : null,
      longitude: canonical.longitude ? String(canonical.longitude) : null,
      yearBuilt: canonical.yearbuilt ? parseInt(canonical.yearbuilt, 10) : null,
      squareFeet: canonical.squarefeet ? parseInt(canonical.squarefeet, 10) : null,
      foundation: translateIsnFoundation(canonical.foundation),
      occupancy: canonical.propertyoccupied === "yes" ? "occupied" : canonical.propertyoccupied === "no" ? "vacant" : null,
    }).returning();

    await db.insert(propertyBusinesses).values({
      propertyId: created.id,
      businessId: SAFEHOUSE_BIZ_ID,
    }).onConflictDoNothing();

    inserted++;
  }

  log("migrate-properties", `Properties: ${inserted} inserted, ${alreadyExisted} already existed`);
  await pool.end();
}

main().catch((err) => {
  logError("migrate-properties", "Fatal", err);
  process.exit(1);
});
