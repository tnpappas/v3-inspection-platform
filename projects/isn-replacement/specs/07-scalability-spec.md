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

Two tables are obvious partition candidates:

- **`audit_log`**: partition by `(business_id, created_at)` quarterly or yearly. At 10x scale this table will be the largest in the system. Quarterly partitions of ~600K rows are easy to drop or archive.
- **`inspections`**: partition by `(business_id, scheduled_at)` yearly. At 10x scale this table is medium-sized but the access pattern is heavily skewed toward "current and upcoming," so partitioning lets old years move off hot indexes.

**Implementation deferred until volume warrants.** Today both tables are non-partitioned. The schema design constraints to keep partitioning a no-rewrite future option:

- Partition key columns (`business_id`, `created_at` or `scheduled_at`) are NOT NULL on these tables. **Confirm in v2 schema annotation pass.**
- Foreign keys do not point INTO `audit_log` or `inspections` from elsewhere. (Inspections has FKs pointing to it from `reschedule_history`, `inspection_inspectors`, etc. Those need partition-aware design when the time comes. Documented now so the migration path is known.)
- Queries always include the partition key in the WHERE clause. The hot-path query analysis below verifies this.

### Sc5. Hot-path query analysis

Four UI surfaces dominate performance:

#### A. Dispatcher dashboard

"Show all inspections in this business with status in (scheduled, confirmed, en_route, in_progress), grouped by inspector, ordered by scheduled_at."

```sql
SELECT * FROM inspections
WHERE business_id = $1
  AND status IN ('scheduled','confirmed','en_route','in_progress')
  AND scheduled_at >= now()
ORDER BY scheduled_at
LIMIT 200;
```

Index served: `(business_id, status, scheduled_at)`. Expected cost at 10x: a single B-tree range scan, sub-10ms.

#### B. Inspector daily view

"Show all inspections for this inspector in this business, today through next 7 days."

```sql
SELECT * FROM inspections
WHERE business_id = $1
  AND lead_inspector_id = $2
  AND scheduled_at BETWEEN $3 AND $4
ORDER BY scheduled_at;
```

Index served: `(business_id, lead_inspector_id, scheduled_at)`. Expected cost: sub-5ms.

#### C. Realtor portal

"Show all inspections where I am a participant in any role, filtered to this business."

```sql
SELECT i.*
FROM inspection_participants ip
JOIN inspections i ON i.id = ip.inspection_id
WHERE ip.participant_id = $1
  AND i.business_id = $2
ORDER BY i.scheduled_at DESC
LIMIT 50;
```

Indexes served: `inspection_participants(participant_id)`, `inspections(id)` PK. Realtor can see across businesses **only if** they are linked through participants in multiple businesses; permissions enforced at the API + RLS layer.

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
