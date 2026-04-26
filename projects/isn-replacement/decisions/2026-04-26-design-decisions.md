# Design Decisions, 2026-04-26

Decisions made before drafting `specs/01-schema.ts`. Locked unless we revisit explicitly.

## D1. Role model: junction table with derived primary role

User-to-role is many-to-many. A new table `user_roles (user_id, role)` carries the assignments. UI gets a derived "primary role" via a deterministic priority order (e.g., `owner > operations_manager > inspector > client_success > viewer`) computed on read.

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

## Open: D5. Active inspector count

Troy will verify in ISN admin and report back. The `/users` crawl shows 19 users with `inspector: "Yes"` and `show: "Yes"`. Troy's earlier statement was 8 to 12 active. Schema spec proceeds with placeholder assumptions and **does not commit to scaling decisions** that depend on this number until confirmed.
