# Design Decisions, 2026-04-26

Decisions made before drafting `specs/01-schema.ts`. Locked unless we revisit explicitly.

## D1. Role model: junction table with derived primary role

**Updated 2026-04-26 21:48 UTC** by the multi-business architecture decision (`2026-04-26-multi-business-architecture.md`). Role assignments are now per-business: `user_roles (user_id, business_id, role)`. The derived "primary role" is computed within the business context the user is currently viewing.

User-to-role is many-to-many. A new table `user_roles (user_id, business_id, role)` carries the assignments. UI gets a derived "primary role" via a deterministic priority order (e.g., `owner > operations_manager > inspector > client_success > viewer`) computed on read.

Reasoning:

- ISN's `/me` proves real users are simultaneously inspector + owner + manager.
- Single-varchar `role` cannot express that without lying about who someone is.
- Permissions live on the role, not the user, so checks become `userHasRole(userId, "owner")` rather than `user.role === "owner"`.
- "Primary role" preserves the simple UI affordances (one badge in the sidebar, one role label on the team page).

The existing `users.role` column will be migrated to seed `user_roles` and then dropped, or kept as a denormalized cache of the primary role. Decision deferred to schema-rationale doc.

## D2. Pagination: cursor for unbounded, offset/limit for bounded

| List type | Strategy |
|---|---|
| `inspections`, `audit_log`, `email_logs`, `email_jobs`, `agreements`, `payment_events`, `automation_logs`, `communication_log`, `inspection_notes`, `files` (per inspection if ever large) | **Cursor-based** (created_at + id tiebreaker, opaque cursor token) |
| `users`, `services`, `email_templates`, `sms_templates`, `agreement_templates`, `automation_rules`, `contact_types`, `agencies`, `offices` | **Offset/limit** with sensible default + max cap |
| `contacts` | **Cursor-based.** Bounded today, unbounded once realtor portal lands. |

Reasoning:

- Cursor pagination is correct for streams that grow forever and need stable iteration during inserts.
- Offset/limit is fine for low-cardinality config tables and is friendlier to UI features like "go to page 5."
- Mixing on purpose, not accidentally. The schema rationale doc captures this so future contributors don't homogenize them.

## D3. Scheduled date/time: `scheduled_at timestamptz` + `duration_minutes`

Drop the existing `scheduled_date (date) + scheduled_time (time) + duration_minutes` triple. Replace with:

- `scheduled_at` as `timestamptz`
- `duration_minutes` retained
- Computed `scheduled_end_at` available via SQL or a generated column for query performance on overlap checks

Reasoning:

- The split forces the application to do timezone math at every read site. Bugs follow.
- ISN serves datetimes as ISO 8601 with offset. Mirror that.
- Overlap detection (existing `inspections/conflicts` endpoint, future drive-time-aware detection) is dramatically simpler with one timestamptz column.
- Yes, this is a breaking change to the existing Replit code. Cost is contained: the existing system has not gone live with real client schedules at scale, so this is the cheapest moment to fix it.

## D4. PII scrub on the snapshot

`attached_assets/Employees_*.xlsx` was shredded and removed. `uploads/` (which was empty) was removed. Snapshot is gitignored at the directory and tarball level. No employee or client data persists in the workspace.

## D5. Sizing assumptions and lifecycle treatment of users

Resolved 2026-04-26 by Troy. The system treats inspector and staff counts as **input data**, not as constants or hardcoded thresholds. The schema must allow add/activate/deactivate of inspectors and other staff dynamically. Re-keying or migration is not acceptable when an inspector is added or an account goes dormant.

### Sizing targets the architecture must hit without rewrite

| Dimension | Today | 2 year | Headroom |
|---|---|---|---|
| Inspectors (active concurrently) | 12 to 20 | 16 to 30 (30 to 50% growth) | Up to **50** |
| Inspections per month | ~200 | ~260 to 300 | Up to ~500 |
| Peak day load | 25 | 35 | Up to 75 |
| Offices | 1 | 1 to 2 (possible) | 5 |

Architecture patterns are picked for the headroom column, not the today column.

### Implications for the schema and indexes

- All inspector references go through `users.id` (UUID). Counts are not encoded in any column, table name, or fixed list.
- Status changes are mutations of a single `users.status` field plus optional removal of role assignments in `user_roles`. No archival table, no "former_inspectors."
- Indexes on `inspections (inspector_id)`, `inspections (scheduled_at)`, `inspections (status)`, and the territory join on `inspector_zips (zip)` are sized for tens of thousands of rows, not millions. Adequate for headroom. Will revisit at Pestheroes/HCJ scale only if those land here.
- Slot computation algorithm runs against `inspector_hours` + `inspector_time_off` + `inspections` overlap. Cost scales linearly in inspectors covered. At 50 inspectors, a single-inspector slot query stays sub-millisecond. A "find any inspector" slot query at 50 inspectors stays comfortably sub-100ms with the indexes above.

### Migration responsibility

The `/users` crawl shows 19 users flagged `inspector: "Yes"` AND `show: "Yes"`. Troy's day-to-day mental model is 8 to 12. The 7 to 11 delta is a **data hygiene issue inside ISN**, not a schema concern. It is the migration plan's job to:

1. Audit the ISN user list during migration prep.
2. Classify each user: pure inspector, office staff, dormant, leftover.
3. Decide per user: import as active, import as inactive, skip entirely.
4. Document the audit results so future-Troy can answer "why did we drop user X."

Captured as a required step in `specs/05-migration-plan.md` when that document is drafted.

### Sizing flag, productization risk

**Updated 2026-04-26 21:48 UTC** by the multi-business architecture decision. Headroom targets below were sized for Safe House alone. Three businesses' shared `customers`, `properties`, `users`, and `transaction_participants` make these tables 2-3x larger than Safe-House-only. Still within headroom. No index or pattern changes. See `2026-04-26-multi-business-architecture.md`.

Logged 2026-04-26: the headroom targets above are appropriate for **Safe House internal use over a 5 year horizon**. They are likely **undersized** if the rebuild is later productized and licensed to other inspection companies. Not a decision tonight. Revisit before any productization commitment. The architectural patterns chosen (UUID PKs, junction tables for many-to-many, indexed FKs, cursor pagination on unbounded lists) do not preclude a larger ceiling, they just have not been validated for it. A productization track would prompt a fresh sizing pass at:

- Tens of tenants, each with their own offices and users.
- Multi-tenancy isolation model (DB-per-tenant vs row-level).
- Background job throughput at aggregate scale.
- Storage and CDN strategy for reports and photos.
- Auth model: SSO, multi-org membership, branded portals.

When we revisit, this entry is the anchor.
