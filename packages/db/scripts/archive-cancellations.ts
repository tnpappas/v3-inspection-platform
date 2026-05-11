/**
 * archive-cancellations.ts — Step 4 sub-task: Export older cancelled orders to CSV.
 *
 * This is called by migrate-orders.ts inline (the archive CSV is written
 * during the order scan). This standalone script can also be run independently
 * to regenerate the archive from the ISN API if needed.
 *
 * Run: npx tsx specs/migration/archive-cancellations.ts
 */

import "dotenv/config";
import {
  pool,
  log,
  logError,
  isnGet,
  isnGetThrottled,
  parseIsnDatetime,
  normalizeIsnString,
  writeCsvHeader,
  writeCsvLine,
} from "./helpers";

const ARCHIVE_CSV = "migration/archived-cancellations.csv";

function getCancellationCutoff(): Date {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  return cutoff;
}

async function main() {
  log("archive-cancellations", "Exporting older cancelled orders to CSV");

  const cutoff = getCancellationCutoff();
  log("archive-cancellations", `Cutoff: ${cutoff.toISOString()}`);

  writeCsvHeader(ARCHIVE_CSV, [
    "isn_order_id", "order_number", "deleted_at", "deleted_by_isn_uid",
    "scheduled_at", "customer_isn_id", "property_address", "property_zip",
    "fee_amount", "ordertype_name", "inspector1_isn_uid",
  ]);

  // Pull all order stubs
  const openResp = await isnGet<{ orders: Array<{ id: string }> }>("/orders?completed=false");
  const compResp = await isnGet<{ orders: Array<{ id: string }> }>("/orders?completed=true");
  const allStubs = [...openResp.orders, ...compResp.orders];
  const uniqueIds = [...new Set(allStubs.map((s) => s.id))];
  log("archive-cancellations", `Total stubs: ${uniqueIds.length}`);

  let archived = 0;

  for (const id of uniqueIds) {
    const resp = await isnGetThrottled<{ order: Record<string, unknown> }>(
      `/order/${id}?withallcontrols=false&withpropertyphoto=false`
    ).catch(() => null);
    if (!resp?.order) continue;

    const order = resp.order;
    const deletedAt = order.deleteddatetime
      ? parseIsnDatetime(order.deleteddatetime as string)
      : null;

    if (!deletedAt || deletedAt >= cutoff) continue; // Not a pre-cutoff cancellation

    writeCsvLine(ARCHIVE_CSV, {
      isn_order_id: String(order.id ?? ""),
      order_number: String(order.oid ?? ""),
      deleted_at: deletedAt.toISOString(),
      deleted_by_isn_uid: String(order.deletedby ?? ""),
      scheduled_at: String(order.datetime ?? ""),
      customer_isn_id: String(order.client ?? ""),
      property_address: [
        normalizeIsnString(order.address1 as string),
        normalizeIsnString(order.city as string),
        normalizeIsnString(order.stateabbreviation as string),
        normalizeIsnString(order.zip as string),
      ].filter(Boolean).join(", "),
      property_zip: normalizeIsnString(order.zip as string) ?? "",
      fee_amount: String(order.totalfee ?? ""),
      ordertype_name: String(order.ordertype ?? ""),
      inspector1_isn_uid: String(order.inspector1 ?? ""),
    });
    archived++;
  }

  log("archive-cancellations", `Archived ${archived} cancelled orders to ${ARCHIVE_CSV}`);
  await pool.end();
}

main().catch((err) => {
  logError("archive-cancellations", "Fatal", err);
  process.exit(1);
});
