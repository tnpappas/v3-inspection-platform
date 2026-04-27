# Scalability Spec

_Status: STUB. Captures the principle-2 requirements set by Troy 2026-04-27 11:52 UTC. Filled out fully after the schema review locks._

## Principle

Today's volumes are modest. Architecture targets must support 10x without redesign.

## Targets

| Dimension | Today | 10x target |
|---|---|---|
| Inspections | 200/month | 2,000/month sustained, 10,000/month peak |
| Active inspectors | 8 to 12 | 50+ |
| Businesses | 3 | 10+ |
| Customers (lifetime) | ~5,000 | 100,000+ |
| Properties (lifetime) | ~5,000 | 100,000+ |
| Audit log entries | 12-24 per inspection | linear with volume |

At the 10x target, audit_log alone produces ~2.4 million rows/year per business. Inspections produce ~24,000 rows/year per business. Customer and property tables grow ~20x today's count. None of these are large by Postgres standards, but they require the right indexes and partitioning posture **declared at design time** so we are not surprised.

## Hard requirements

### Sc1. UUIDs as primary keys, foreign keys

Already in the v2 schema draft. Locked. Reasoning:

- Avoids hot-spotting on auto-incremented sequences during write-heavy periods.
- Lets us merge data across environments without ID collisions.
- Produces unguessable IDs (helpful for security S1, S5).
- Cost: ~16 bytes per ID vs 8 for bigint. Acceptable.

### Sc2. Cursor pagination on unbounded lists

Per D2. Cursor pagination on `inspections`, `audit_log`, `email_logs`, `email_jobs`, `agreements`, `payment_events`, `automation_logs`, `communication_log`, `inspection_notes`, `customers`, `properties`, `transaction_participants`. Offset/limit on bounded lists like `services`, `businesses`, `users`, `email_templates`.

Cursor format: opaque base64-encoded `{ createdAt: ISO, id: UUID }`. Stable under concurrent inserts. Stable across page boundaries.

### Sc3. Composite indexes on common query patterns

Mandatory composites to declare at schema lock-in:

| Table | Index | Reason |
|---|---|---|
| `inspections` | `(business_id, status, scheduled_at)` | Dispatcher dashboard, "show me everything for my business that is scheduled, ordered by date." |
| `inspections` | `(business_id, lead_inspector_id, scheduled_at)` | Inspector daily view. |
| `inspections` | `(business_id, customer_id, scheduled_at desc)` | Customer history lookup. |
| `inspections` | `(business_id, property_id, scheduled_at desc)` | Property history lookup. |
| `user_businesses` | `(business_id, user_id)` | Membership check on every authenticated request. |
| `user_roles` | `(user_id, business_id)` | Permission checks. |
| `audit_log` | `(business_id, created_at desc)` | Per-business audit views. |
| `audit_log` | `(entity_type, entity_id, created_at desc)` | Per-entity history (already in v1 draft). |
| `inspector_zips` | `(business_id, zip)` | Slot computation, "which inspectors cover this ZIP for this business?" |
| `customers` | `lower(email)`, `lower(display_name)` | Search and dedupe. |
| `properties` | `(zip, lower(address1))` | Property dedupe and lookup. |

These get explicit `index()` declarations in the schema draft on the next pass.

### Sc4. Partitioning strategy, designed but not implemented

Two tables are obvious partition candidates. **Schema is partition-ready: partition key columns are NOT NULL, no incoming FKs from other tables on the partition keys, queries always include the partition key in the WHERE clause.**

#### audit_log partitioning

Partition by `(account_id, created_at)` quarterly.

**Row count math (updated 2026-04-27 with read_sensitive multiplier):**

- Base writes per audit-event: ~12M/year per account at 10x.
- Read-sensitive multiplier (S5 reads of PII produce audit entries): **2-3x**.
- Realistic upper bound at 10x scale: **24-36M rows/year per account**.
- Quarterly partitions: **6-9M rows per partition per account**.
- Postgres handles partitions of this size comfortably; partition pruning means a query for "last 30 days of audit_log for account X" touches one partition.

When to implement: when audit_log row count for a single account crosses ~10M total, or when queries on the table show degraded latency. Whichever first.

Retention via partition drop: the data-retention job becomes "DROP PARTITION older than the configured window" instead of row-by-row DELETE. Far faster.

#### inspections partitioning

Partition by `(business_id, scheduled_at)` yearly.

**Row count math:**

- ~24,000 inspections/year per business at 10x sustained.
- ~600,000 cumulative inspections per business after 25 years.
- Yearly partitions of ~24K rows are small but still useful for query pruning (current year and prior year cover 99% of working queries).
- The access pattern is heavily skewed toward "current and upcoming," so partitioning lets old years move off hot indexes.

When to implement: at the same time as audit_log partitioning, since the operational machinery (partition naming convention, retention policy, monitoring) is the same.

#### Constraints already in place to keep partitioning a no-rewrite future move

- `audit_log.account_id` is NOT NULL.
- `audit_log.created_at` has a NOT NULL default of `now()`.
- `inspections.business_id` is NOT NULL.
- `inspections.scheduled_at` is NOT NULL.
- No FKs from other tables point at `audit_log.id` (it has no children).
- FKs pointing at `inspections.id` exist (from `reschedule_history`, `inspection_inspectors`, `inspection_participants`, `inspection_services`). Postgres declarative partitioning supports FKs to partitioned tables as of 12+; we are on 16. Should not block, but worth verifying when implementing.

### Sc5. Hot-path query analysis (refreshed for v3 schema lock 2026-04-27)

Four UI surfaces dominate performance. All queries reference `account_id` or transitively inherit it via FK chain to satisfy RLS. Composite indexes lead with the most-selective field for the query (typically `business_id` for operational queries; `account_id` for cross-business shared-table queries).

Four UI surfaces dominate performance:

#### A. Dispatcher dashboard

"Show all inspections in this business with status in (scheduled, confirmed, en_route, in_progress), grouped by inspector, ordered by scheduled_at."

```sql
SELECT * FROM inspections
WHERE business_id = $1
  AND status IN ('scheduled','confirmed','en_route','in_progress')
  AND scheduled_at >= now()
  AND deleted_at IS NULL
ORDER BY scheduled_at
LIMIT 200;
```

Index served: `inspections_biz_status_scheduled_idx` on `(business_id, status, scheduled_at)`. RLS adds the implicit account scope. Expected cost at 10x: a single B-tree range scan, sub-10ms.

#### B. Inspector daily view

"Show all inspections for this inspector in this business, today through next 7 days."

```sql
SELECT * FROM inspections
WHERE business_id = $1
  AND lead_inspector_id = $2
  AND scheduled_at BETWEEN $3 AND $4
  AND deleted_at IS NULL
ORDER BY scheduled_at;
```

Index served: `inspections_biz_inspector_scheduled_idx` on `(business_id, lead_inspector_id, scheduled_at)`. Expected cost: sub-5ms.

#### C. Realtor portal

"Show all inspections where I am a participant in any role, filtered to this business."

```sql
SELECT i.*
FROM inspection_participants ip
JOIN inspections i ON i.id = ip.inspection_id
WHERE ip.participant_id = $1
  AND i.business_id = $2
  AND i.deleted_at IS NULL
ORDER BY i.scheduled_at DESC
LIMIT 50;
```

Indexes served: `inspection_participants_participant_idx`, `inspections(id)` PK. The realtor is a `transaction_participant` row scoped to the account. They can see participants on inspections across businesses only if they have the relevant `transaction_participants` row linked. RLS plus the API permission check enforce account-and-business scoping.

#### D. Available slot computation

"For inspector X in business Y, return all 30-minute windows in the next 14 days that:
- Fall within their `inspector_hours` for that day-of-week
- Do not overlap their `inspector_time_off`
- Do not overlap an existing `inspections` row where they are the lead or secondary
- Cover at least the requested service duration"

This is the most complex query in the system. Plan:

```sql
-- Step 1: candidate days from inspector_hours
WITH days AS (
  SELECT generate_series($start_date, $end_date, '1 day'::interval) AS day
),
hours AS (
  SELECT d.day, ih.start_time, ih.end_time
  FROM days d
  JOIN inspector_hours ih
    ON ih.day_of_week = EXTRACT(DOW FROM d.day)
   AND ih.user_id = $inspector_id
   AND ih.business_id = $business_id
   AND (ih.effective_from IS NULL OR ih.effective_from <= d.day)
   AND (ih.effective_to IS NULL OR ih.effective_to >= d.day)
),
-- Step 2: subtract time_off
-- Step 3: subtract existing inspections
-- Step 4: produce 30-minute slots within remaining windows
```

Worst case at 10x: 50 inspectors × 14 days × 96 30-minute slots = 67,200 slot candidates per cross-inspector query. Pure SQL is too slow at that scale. **The slot algorithm runs as a service-layer function with caching, not as a single SQL query.** Caching strategy in Sc7.

#### E. Cross-business customer history (added 2026-04-27)

A designed use case (Pattern B): "Show all activity for customer X across all businesses they have used." Common scenario: Sarah Williams uses Safe House for an inspection, then HCJ for pool service. Single customer record, two businesses, multiple operational rows.

```sql
-- Step 1: confirm customer is in this account
SELECT * FROM customers WHERE id = $customerId AND account_id = $accountId AND deleted_at IS NULL;

-- Step 2: list businesses the customer has activity with
SELECT cb.business_id, b.name, cb.first_seen_at, cb.last_activity_at
FROM customer_businesses cb
JOIN businesses b ON b.id = cb.business_id
WHERE cb.customer_id = $customerId AND b.account_id = $accountId
ORDER BY cb.last_activity_at DESC;

-- Step 3: pull operational rows from each business (today: inspections only)
SELECT * FROM inspections
WHERE business_id IN ($businessIds)
  AND customer_id = $customerId
  AND deleted_at IS NULL
ORDER BY scheduled_at DESC
LIMIT 100;
```

Indexes served:

- Step 1: `customers` PK plus `(account_id)` filter via `customers_account_idx`.
- Step 2: `customer_businesses` PK on `(customer_id, business_id)`.
- Step 3: `inspections_biz_customer_scheduled_idx` on `(business_id, customer_id, scheduled_at)`.

Expected cost at 10x: each step sub-10ms; total cross-business customer history query well under 50ms.

When pool_jobs and pest_treatments tables land, Step 3 fans out into a UNION ALL across operational tables filtered by business_id. The pattern stays the same; the additional cost is one indexed lookup per business type.

### Sc6. Read replica readiness

Reporting queries (dashboards, analytics, exports) should be able to run against a Postgres read replica without code changes.

Requirements:

- The Drizzle pool config in `server/db.ts` accepts a separate `READ_DATABASE_URL`. Reporting routes use a "reader" db handle.
- All write paths use the writer pool. All hot UI paths use the writer pool (consistency).
- Reporting routes annotated with a `@reader` marker so they pick the replica handle.
- Replica lag is acceptable for reports (seconds to minutes). Not acceptable for the dispatcher dashboard or the inspector daily view.

Not implemented day one. Architecture supports it without restructure.

### Sc7. Caching strategy

Three caching surfaces:

#### Computed availability

The slot algorithm output for "show me available slots for inspector X next 14 days" is recomputed only when:

- Inspector hours change for that user.
- Inspector time-off changes for that user.
- An inspection is created, updated, or cancelled where the inspector is involved.

Cache key: `slots:{business_id}:{user_id}:{start_date}:{end_date}`. TTL 30 minutes; invalidated by the events above. Storage: Redis or equivalent in-memory store. Not built day one, but the slot service is written to call a `getCachedSlots()` shim that is a no-op until the cache is wired in.

#### Aggregated reports

Dashboard counts (total inspections, by status, by month) are computed once per minute per business and stored in a `dashboard_metrics` cache row. Re-rendered at request time from the cache.

#### Per-request memoization

Within a single HTTP request, repeat lookups of the same user/business/role are memoized via `req.context`. Standard pattern, no infrastructure needed.

## Schema-level checklist (per-table)

Every table in `specs/01-schema.ts` carries a header comment confirming evaluation:

```
// Scalability: [partition key | none], [hot indexes], [expected row count at 10x]
```

## Open items for spec finalization

1. Specific partition implementation (range, list, hash) for audit_log and inspections.
2. Cursor encoding scheme.
3. Read replica deployment topology.
4. Cache backend choice (Redis, in-memory LRU, edge cache).
5. Connection pool sizing at 10x scale.
6. Background worker queueing strategy (currently process-email-jobs.ts is a poll loop; at 10x we likely want pg-boss, BullMQ, or similar).
