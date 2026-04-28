/**
 * extract-orders.ts — Step 2.5: Pull all qualifying order details from ISN
 * and write to a local JSON file.
 *
 * Both migrate-properties.ts and migrate-orders.ts read from this file.
 * Running this once and reusing the file avoids redundant API calls and
 * ensures both downstream scripts work from identical data.
 *
 * Output: migration/orders-full.json (gitignored, PII)
 * Run before migrate-properties.ts and migrate-orders.ts.
 *
 * Run: npx tsx specs/migration/extract-orders.ts
 * Estimated time: varies by order count; ~60+ minutes for 60k stubs at 400ms throttle.
 * Use RESUME=true to skip orders already in the output file.
 */

import "dotenv/config";
import * as fs from "fs";
import { log, logError, isnGet, isnGetThrottled, parseIsnDatetime } from "./helpers";

const OUTPUT_FILE = "migration/orders-full.json";
const PROGRESS_FILE = "migration/extract-orders-progress.json";

function getCancellationCutoff(): Date {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  return cutoff;
}

/** Returns true if this order stub might qualify for import or archiving (fast pre-filter). */
function mightQualify(stub: { id: string }): boolean {
  // All stubs pass at this stage; filtering happens in migrate-orders.ts
  return true;
}

async function main() {
  log("extract-orders", "Starting order extraction from ISN");

  const resume = process.env.RESUME === "true";
  const dir = "migration";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Load already-extracted IDs if resuming
  const alreadyDone = new Set<string>();
  const extractedOrders: Record<string, unknown>[] = [];

  if (resume && fs.existsSync(OUTPUT_FILE)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8")) as Record<string, unknown>[];
    for (const o of existing) {
      alreadyDone.add(o.id as string);
      extractedOrders.push(o);
    }
    log("extract-orders", `Resuming: ${alreadyDone.size} orders already extracted`);
  } else {
    fs.writeFileSync(OUTPUT_FILE, "[]", "utf8");
  }

  // Pull all order stubs
  log("extract-orders", "Pulling order stubs...");
  const openResp = await isnGet<{ orders: Array<{ id: string }> }>("/orders?completed=false");
  const compResp = await isnGet<{ orders: Array<{ id: string }> }>("/orders?completed=true");
  const allStubs = [...openResp.orders, ...compResp.orders];
  const uniqueIds = [...new Set(allStubs.map((s) => s.id))];
  log("extract-orders", `Total unique stubs: ${uniqueIds.length}`);

  const toFetch = resume
    ? uniqueIds.filter((id) => !alreadyDone.has(id))
    : uniqueIds;
  log("extract-orders", `To fetch: ${toFetch.length}`);

  let fetched = 0, failed = 0;
  const BATCH_SAVE = 100; // Save progress every 100 orders

  for (let i = 0; i < toFetch.length; i++) {
    const id = toFetch[i];
    const resp = await isnGetThrottled<{ order: Record<string, unknown> }>(
      `/order/${id}?withallcontrols=true&withpropertyphoto=false`
    ).catch(() => null);

    if (!resp?.order) {
      failed++;
      continue;
    }

    extractedOrders.push(resp.order);
    fetched++;

    // Save progress periodically
    if (fetched % BATCH_SAVE === 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(extractedOrders, null, 2), "utf8");
      log("extract-orders", `Progress: ${fetched}/${toFetch.length} fetched (${failed} failed)`);
    }
  }

  // Final save
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(extractedOrders, null, 2), "utf8");
  log("extract-orders", `Done. ${fetched} extracted, ${failed} failed. File: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  logError("extract-orders", "Fatal", err);
  process.exit(1);
});
