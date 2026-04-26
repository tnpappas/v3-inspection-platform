# Phase 2 Block B (Augment) + Block C (History) Findings

_Run 2026-04-26 22:58 UTC and following. 7 augment detail calls + 5 history calls, 12 total. All HTTP 200. Phase 2 now complete pending Troy's review._

## Calls

| # | Endpoint | Selection reason | HTTP | Bytes |
|---|---|---|---|---|
| augment-1 | `GET /order/{id}` | hidden_or_cancelled (show=no) | 200 | 70,550 |
| augment-2 | `GET /order/{id}` | hidden_or_cancelled (show=no) | 200 | 70,256 |
| augment-3 | `GET /order/{id}` | hidden_or_cancelled (show=no) | 200 | 70,250 |
| augment-4 | `GET /order/{id}` | aged (modified 60+ days ago) | 200 | 74,039 |
| augment-5 | `GET /order/{id}` | completed_variety | 200 | 70,597 |
| augment-6 | `GET /order/{id}` | completed_variety | 200 | 70,608 |
| augment-7 | `GET /order/{id}` | completed_variety_extra | 200 | 70,769 |
| history-1 | `GET /order/history/{id}` | pilot-6 (completed) | 200 | 5,727 |
| history-2 | `GET /order/history/{id}` | pilot-7 (completed) | 200 | 5,924 |
| history-3 | `GET /order/history/{id}` | augment-1 (deleted) | 200 | 4,024 |
| history-4 | `GET /order/history/{id}` | augment-4 (aged) | 200 | 6,625 |
| history-5 | `GET /order/history/{id}` | pilot-1 (open recent) | 200 | 6,101 |

Phase 2 cumulative: 3 (Block A list) + 8 (pilot detail) + 7 (augment) + 5 (history) = **23 read-only calls**, well under the original 50 budget. Plus the original 4 from Phase 0 and 5 from Phase 1, total ISN crawl footprint to date is **35 calls**.

## Big findings

### 1. ISN does NOT have a "canceled" status. Cancelled orders are SOFT-DELETED.

The biggest finding of the augment. Three orders selected with `show=no` (the "hidden" stubs) all have:

- `canceled: "no"`
- `complete: "no"`
- `deleteddatetime` populated (e.g., `2026-04-25 16:42:41`)
- `deletedby` populated (UUID of the staff member who deleted)

**ISN's UI affordance for "cancel an order" is "delete the order."** There is no actual cancellation workflow. The `canceled` flag is unused in practice (or used for some other meaning we have not yet discovered).

This matters significantly:

- **Migration:** ISN orders with `deleteddatetime IS NOT NULL` should map to v2 `inspections.status = 'cancelled'`, with `cancelledAt = deleteddatetime` and `cancelledBy = deletedby`. Not literal deletion.
- **The 61,387 orders in Block A includes deleted ones.** Migration cut criteria need to consider: do we import deleted orders as `cancelled`, or skip them entirely? Recommendation: import the most recent N years of deleted orders as `cancelled` so historical reporting remains accurate, skip older ones.
- **Platform issue #9:** ISN has no first-class cancellation status. "Delete" is overloaded. Logging.
- **The `canceled` flag's actual purpose** is unclear. Possibly internal flag never exposed to staff. Worth a question to ISN support if this rebuild ever needs to talk to them, otherwise treat as vestigial.

### 2. Status truth table updated

Previous pilot showed status was a 5-flag conjunction. With `deleteddatetime` added, the real picture is:

| Logical state | `show` | `complete` | `paid` | `signature` | `canceled` | `deleteddatetime` |
|---|---|---|---|---|---|---|
| Scheduled (active) | yes | no | * | * | no | null |
| Completed | yes | yes | * | yes | no | null |
| Cancelled (in ISN: "deleted") | no | no | * | * | no | **populated** |

`paid` and `signature` are orthogonal axes that align with v2's `paymentStatus` and `signatureStatus`. `complete` and `deleteddatetime` are the two state-determining axes. The migration helper `derive_status_from_isn_flags()` needs the `deleteddatetime` field, not just the 5 flags from the pilot.

### 3. Aged order survived intact

`augment-4` was modified 2026-02-25 (60 days back). All 66 fields present, full `controls[]` and `fees[]`. **ISN does not garbage-collect or compress old orders.** Lifetime data is fully fetchable via `GET /order/{id}`. Good news for migration coverage.

### 4. Inspector pool diversity

Across the 15 orders we have detail for (8 pilot + 7 augment), there are **5 distinct `inspector1` UUIDs**. The dispatch is concentrated, even on aged orders. This is consistent with Troy's earlier "8 to 12 active inspectors" estimate. The full migration audit will show the long tail.

### 5. Order type concentration

Across 15 orders: **3 distinct `ordertype` UUIDs**. So 80%+ of recent orders fall into the same handful of types. Phase 1 showed 16 active order types. The discrepancy means most order types are rarely used. Migration plan should:

- Migrate all 16 order types as historical reference.
- Mark the long-tail rarely-used ones as `active=false` in v2 unless someone confirms they are still in use.
- Cleaner catalog from day one.

### 6. Territories thin: still only "Territory A"

Across all 15 orders, **11 carried "Territory A," 4 had no territory assigned (null)**. No second territory observed.

**Conclusion:** Safe House operationally uses one territory. The territory-name "Territory A" is leftover from a multi-territory ambition or template. Recommendations:

- Keep the `territories` table in v2 schema as designed. Cost is minimal.
- Seed it with a single row matching the office.
- Migration assigns all orders to the seeded territory, including the 4 nulls (they are still Safe House work; the null is data hygiene, not a different region).
- Document this finding in `04-field-mapping.md` so future-Troy understands why the territory table exists but is single-row.

### 7. History endpoint vocabulary, the dispatch audit trail

5 history calls returned 12 to 24 events each. Event structure:

```json
{
  "uid": "<user-UUID-or-empty-for-system>",
  "by": "Jelai Cachin",        // human name, or "SYSTEM"/"ISN"
  "when": "2026-04-21T09:49:19-07:00",   // -07:00 = ISN's Pacific clock again (timezone issue from Phase 0)
  "changes": {                  // dict of field -> new value
    "Created By": "Jelai Cachin",
    "Inspection Date": "04/21/2026",
    "Inspection Time": "1:30 PM",
    "Inspector #1": "Bruce Smith",
    ...
  }
}
```

**Distinct change-tracked fields across the 5 histories: 42 fields.** Top frequencies show the audit trail prioritizes:

| Rank | Field | Count |
|---|---|---|
| 1 | Order Paid | 17 |
| 2 | Duration | 13 |
| 3 | Total Fee | 12 |
| 4 | Inspection Date | 10 |
| 5 | Inspection Time | 10 |
| 6 | Inspector #1 | 10 |
| 7 | Latitude / Longitude | 10 each (geocoding) |
| 8 | Order Type / Inspection Type | 7 |
| 9 | Inspector #2 | 6 |
| 10 | Address (line 1) | 6 |

Plus 32 lower-frequency fields including: Order Signed, Inspector #3-#10, Sales Price, Square Feet, Year Built, Seller's/Buyer's Agent, ReportNumber, Completed By, Scheduled By, City, State, Zip, County, Property Photo, etc.

**Implications for v2:**

- The history endpoint is **rich enough to drive an audit log import**. Each history event maps to a row in v2's `audit_log` table with `entityType='inspection'`, `entityId=<inspection-id>`, `userId=<lookup uid>`, `action='update'`, `changes={fieldName: newValue}`.
- The "by" field is the human display name. UID is the ISN user UUID. Migration looks up our v2 user via `users.isnSourceId = uid` and stores our user's UUID, falling back to a synthetic "ISN System User" when uid is empty (system events).
- ISN's history is **append-only and complete.** Every meaningful change is logged. Better than the current Replit project's audit_log, which only captures CRUD wrapper actions.
- **Reschedule events are inferable from history.** When an event has both "Inspection Date" and "Inspection Time" in `changes`, that is a reschedule. Migration can populate v2's `reschedule_history` from these patterns.

### 8. Time zone confirmed, again

History events return `when` in `-07:00` (Pacific). Confirms Phase 0 finding. **All datetime parsing during migration must be timezone-aware.** The migration helper for parsing ISN datetimes (`parse_isn_datetime()`) needs to convert `-07:00` to UTC before storing in v2's `timestamptz` columns.

### 9. The "InspectorLab Triggered" event

3/5 histories had an "InspectorLab Triggered" event in their changes. This is an integration with InspectorLab (a separate vendor, possibly a sample analysis or compliance check tool). Not in scope for the scheduling slice. Captured here so future-Troy or a later slice knows the integration exists.

## Platform issues update

### Append #9 to `isn-platform-issues.md`

> ISN has no first-class cancellation workflow. The UI's "Cancel" action sets `deleteddatetime` and `deletedby` on the order, then hides it from default views (`show=no`). The `canceled` boolean flag remains "no." Three of three "hidden" orders sampled in Phase 2 augment showed this pattern: `show=no`, `canceled=no`, `complete=no`, but `deleteddatetime` populated. This conflates two different concepts (cancel vs. delete) into one action, and leaves the literal `canceled` flag as ambiguous-or-vestigial. Integrators reading the spec literally will look for cancellation in the wrong field.

## Schema delta updates

Already in `01-schema-rationale.draft.md`, but adding nuance from augment:

### Update to migration helper requirements

- `derive_status_from_isn_flags(order)` must consider `deleteddatetime`. Returns `'cancelled'` when `deleteddatetime IS NOT NULL`. Pseudocode:

```ts
function deriveStatusFromIsnOrder(o: ISNOrder): InspectionStatus {
  if (o.deleteddatetime) return 'cancelled';
  if (o.complete === 'yes') return 'completed';
  if (o.confirmeddatetime && !o.completeddatetime) return 'confirmed';
  if (o.scheduleddatetime) return 'scheduled';
  return 'scheduled'; // fallback
}
```

- `parse_isn_datetime(s)` handles both formats observed: `"2026-04-27 13:30:00"` (no tz, treated as Pacific) and `"2026-04-26T19:46:06+00:00"` (UTC offset). Always returns timezone-aware UTC.

### History import as audit_log seed

The migration plan should call `GET /order/history/{id}` for every imported inspection, parse the events, and insert one `audit_log` row per event. Cost: one extra API call per migrated inspection, but produces a real audit trail in v2 from day one rather than an empty `audit_log`.

### Updated cut list (cancellation fields are NOT empty, redacting from cut list)

The pilot showed `cancelreason`, `cancelreasonstring`, `canceledby`, `canceleddatetime` empty in 8/8 pilots. The augment confirms this is because ISN does not use the cancel pathway. They use delete.

**Updated cut list:** `canceled` flag and `cancelreason*` fields are still cut (always empty in practice), but `deleteddatetime` and `deletedby` are NOT cut. They are renamed during migration to `cancelledAt` and `cancelledBy` on v2 inspections.

## Block C status

Block C (history) included as part of this augment run. Originally planned as a separate step; merged into the same execution batch since both inform the migration plan. Phase 2 is **complete pending Troy's review** of these findings.

## What remains in Phase 3 (slot probing)

Independent of Phase 2 results. Still requires Troy's go-ahead. Smaller (~12 calls) and the algorithmic-discovery-only phase.

## Decisions Troy should weigh in on

1. **Approve the platform-issue #9 append** as drafted above?
2. **Approve adding `parse_isn_datetime()` and `derive_status_from_isn_order()` as named helpers** in the migration plan, to be implemented when that doc is drafted?
3. **Migrate deleted orders as cancelled?** Recommendation: yes, last 3 years of deleted orders import as `status='cancelled'`. Older deleted orders skip.
4. **Migrate per-order audit history?** Recommendation: yes, one `audit_log` row per ISN history event. Costs ~N extra API calls during migration where N = number of inspections migrated. Worth it for day-one audit trail.
5. **Phase 3 (slot probing) approval**, or hold for morning?
