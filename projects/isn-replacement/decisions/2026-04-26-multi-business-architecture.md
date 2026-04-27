# Multi-Business Architecture (Pattern B with account layer)

_Decided 2026-04-26 by Troy as Pattern B over the v1 single-business assumption. Updated 2026-04-27 with the licensing-readiness account layer that wraps Pattern B. Schema implementation locked at git tag `v3-schema-locked`._

## Final architecture, three-layer summary (added 2026-04-27)

The rebuild has three layers, each with its own isolation boundary:

1. **Account** (licensing tenant). Top-level. One row today (ours). Future licensees are additional rows. A user belongs to exactly one account (Pattern 1). Cross-account isolation enforced via RLS at the database layer plus INV-1 application-layer invariant.

2. **Business** (operational unit). Within an account. Three rows in our account today: Safe House (inspection), HCJ (pool), Pest Heroes (pest). Each has its own services catalog, technician availability, and operational records (inspections today; pool_jobs and pest_treatments later). Users opt into businesses via `user_businesses` junction; roles are per-business via `user_roles` keyed on (user, business, role).

3. **Customers, properties, transaction participants, agencies** (shared within account). Account-scoped, shared across businesses. Junctions (`customer_businesses`, `property_businesses`, `agency_businesses`) track cross-business activity without duplicating rows. The bill-to-closing workflow uses transaction_participants (lenders and attorneys) as participants on inspections.

The two `decisions/2026-04-26-design-decisions.md` decisions D1 (per-business roles), D2 (pagination), D3 (timestamptz), D5 (sizing as input data) all carry forward and apply within the layered model. D4 (PII scrub) was a one-time event, complete.

## v3 schema state at lock (added 2026-04-27)

- 27 tables, 17 enums, 61 PII column markers, 7 soft-delete tables, 7 tables with direct `account_id`.
- Two partition candidates declared (audit_log on (account_id, created_at) quarterly; inspections on (business_id, scheduled_at) yearly), implementation deferred until volume warrants.
- Two critical invariants enforced at application layer (INV-1 audit_log account match; INV-2 RLS session variables set per request).
- Forensic correlation columns (sessionId, requestId) on audit_log; outcome enum captures denied/failed/partial events.
- Per-business Postgres sequences for order_number (race-free, year-format-preserving).
- User credentials, login security, MFA factors split into dedicated tables; users table is metadata only.
- Email verification, role expiration, bill-to-closing column all in place.

Full rationale at `specs/01-schema-rationale.md`.

---

_Original decision below, preserved for the design-history thread._

# Multi-Business Architecture (Pattern B)

_Decided 2026-04-26 by Troy. Supersedes the implicit single-business assumption that drove the v1 schema draft (now `specs/01-schema.v1.draft.ts.superseded`)._

## Decision

The rebuild is a **multi-business platform from the foundation**, not a Safe House replacement that becomes multi-business later. Architecture pattern is **Pattern B: shared customers and properties across businesses, separated users and operations per business.**

## Scope

**In scope, day one as `businesses` rows:**

| Business | Type | Status |
|---|---|---|
| Safe House Property Inspections | inspection | active, only one with operational tables built (inspections) |
| HCJ Pool Services | pool | active record, no operational tables built (continues using Skimmer) |
| Pest Heroes | pest | active record, no operational tables built (continues using FieldRoutes) |

**Out of scope:**

- **My Driven Threads.** Stays on Shopify. Not represented in this system.

**Future operational tables (not built now, structurally parallel to `inspections`):**

- `pool_jobs` for HCJ
- `pest_treatments` for Pest Heroes

When and whether each gets built is a per-business decision. The schema today does not preclude either.

## Architecture rules

1. **Customers and properties are shared across businesses.** A single `customers` row is reused across Safe House inspections, HCJ pool service, and Pest Heroes treatments. Same for `properties`. No `business_id` on these rows. This is the entire point of Pattern B: cross-sell visibility, single source of truth for who and where.

2. **Cross-business activity is tracked via junctions, not duplication.**
   - `customer_businesses (customer_id, business_id, first_seen_at, last_activity_at, status)`
   - `property_businesses (property_id, business_id, first_seen_at, last_activity_at, status)`
   - These answer "which businesses has this customer used" and "which businesses have serviced this property" without duplicating the rows.

3. **Transaction participants are shared, separate from customers.** Realtors, transaction coordinators, escrow officers, insurance agents, and similar roles participate in customers' transactions but are not customers themselves. They live in `transaction_participants`, no `business_id`. They link to operational records (today, only `inspections`) through per-operation junctions like `inspection_participants` with a `role_in_transaction` column.

4. **Agencies are shared with a junction.** `agencies` has no `business_id`. The `agency_businesses` junction tracks which of our businesses transact with which brokerage. A property-management firm could conceivably hire both Safe House and HCJ; this allows that without forcing a duplicate agency row.

5. **Users belong to one or more businesses.** `user_businesses (user_id, business_id, is_primary)` is the membership table. `is_primary` indicates which business a user identifies with most strongly (for default UI, default landing page, default reports). Pool techs belong to HCJ only. Inspectors belong to Safe House only. Owners belong to multiple.

6. **Roles are per-business.** `user_roles (user_id, business_id, role)` is the existing junction (D1) extended with a business scope. "Inspector at Safe House" is distinct from "Pool Tech at HCJ." A user can hold roles in multiple businesses simultaneously.

7. **Operational data is business-scoped.** Every operational row (inspections today, pool_jobs and pest_treatments later) carries `business_id`. Same for operational reference tables: `services`, `inspector_hours`, `inspector_time_off`, `inspector_zips`, `inspector_service_durations`. Cross-business queries are explicit by joining or unioning, never accidental.

8. **Account-level concerns are deferred to a future `accounts` table.** Master config, billing, multi-business management, white-label settings. Not built now. Placeholder mentioned in the schema so the decision is on record.

9. **Permissions scope to business membership.** A user can only see data for businesses they belong to. Owners belonging to multiple businesses see across. Permission checks become `userIsInBusiness(userId, businessId) AND userHasRole(userId, businessId, role)`.

10. **The `inspections` table is the canonical pattern.** It carries `business_id`, references shared `customers` and `properties`, supports `inspection_participants` and `inspection_services` junctions. `pool_jobs` and `pest_treatments` will mirror this pattern when they are built.

## What this changes vs the v1 draft

| Concern | v1 draft | v2 draft |
|---|---|---|
| Top-level grouping | implicit single business | explicit `businesses` table |
| Users | flat user list | `user_businesses` membership |
| Roles | `(user_id, role)` | `(user_id, business_id, role)` |
| Customers | inside `contacts` with type discriminator | own `customers` table, shared, no business_id |
| Realtors / TCs / escrow | inside `contacts` with type discriminator | own `transaction_participants` table, shared, linked via `inspection_participants` junction |
| Properties | inline columns on `inspections` | own `properties` table, shared, no business_id |
| Agencies | flat business-scoped | shared with `agency_businesses` junction |
| Inspections, services, schedules | implicit Safe House | explicit `business_id`, foreign keys to shared customers and properties |
| Audit log | global | gains `business_id` for scoped queries |
| Cross-business activity | not modeled | `customer_businesses`, `property_businesses` junctions |

## Build implications

- **Safe House cutover stays the priority.** The multi-business architecture does not delay it. The build today is: businesses table seeded with three rows, only Safe House has operational tables, only `inspections` is built.
- **HCJ stays on Skimmer until further notice.** The new system holds HCJ users, customers, and properties only.
- **Pest Heroes stays on FieldRoutes until further notice.** Same pattern, users + customers + properties.
- **Decision to migrate HCJ or Pest Heroes operational data** into this system is per-business and not on the current roadmap.

## Migration implications

Two new classification steps are now required in `specs/05-migration-plan.md` when it is drafted, in addition to the user-audit step from D5:

1. **User-to-business classification.** Every ISN user we import becomes a row in `user_businesses` with one or more business memberships. Pool techs map to HCJ. Pest techs map to Pest Heroes. Inspectors map to Safe House. The bookkeeper maps to all three with appropriate roles. Owners map to all three. Document each classification with reasoning.

2. **Contact split classification.** ISN's current `clients` and `agents` get split:
   - **Clients** map mostly to `customers`. Edge cases (a "client" who is actually a property manager handling many transactions) get reviewed.
   - **Agents** (real estate agents) map to `transaction_participants` with `role_in_transaction = buyer_agent` or `listing_agent`. They appear on `inspection_participants` rows for the inspections they were on.
   - **Escrow officers and insurance agents** map to `transaction_participants` with the appropriate role.
   - A single ISN agent record might split into one `transaction_participants` row plus multiple `inspection_participants` rows.

## Sizing flag, restated for multi-business

The headroom targets in `decisions/2026-04-26-design-decisions.md` D5 (50 inspectors, 500 inspections/month, 5 offices) were sized for Safe House alone. With three businesses' users and customers in the system from day one, the table-row counts on `users`, `customers`, `properties`, and `transaction_participants` are 2 to 3x what Safe-House-only would be. Still well within headroom. No index or pattern changes required. The productization risk flag in D5 still applies, and is now slightly more relevant since the multi-business shape is closer to a productizable pattern.

## What is NOT changing

- D2 (pagination strategy) unchanged.
- D3 (`scheduled_at timestamptz`) unchanged.
- D4 (PII scrub) unchanged.
- The existing Replit project's reused tables (files, agreements, payments, automations, emails, SMS, integrations, communication log, inspection notes) reused as-is for now, with the understanding that each gets a `business_id` migration when its parent operation gets one. Not all need it day one. The scheduling slice's reused tables get reviewed in the schema rationale doc when that is written.

## Cross-references

- `specs/01-schema.ts` (new v2 draft, this directive's output)
- `specs/01-schema.v1.draft.ts.superseded` (preserved v1 for design history)
- `decisions/2026-04-26-design-decisions.md` (D1, D2, D3, D4, D5 carry forward)
- `discovery/05-phase2-plan.md` (Phase 2 paused; resumes after schema review)
- `discovery/04-phase1-results.md` (the user/agent stub findings inform the migration classification step)
- `specs/05-migration-plan.md` (will absorb both classification steps)
