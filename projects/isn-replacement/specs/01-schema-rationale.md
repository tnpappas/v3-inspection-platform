# Schema Rationale (v3, locked)

_Companion to `specs/01-schema.ts`. Captures design reasoning, ISN deviations, and architectural decisions made during the v3 review cycle._

_Status: LOCKED 2026-04-27 alongside the schema (git tag `v3-schema-locked`). Subsequent updates land in additive sections rather than rewrites; the chronological journal below preserves the "why this came up when it came up" thread for future readers._

## Table of contents

1. [Architectural overview](#architectural-overview)
2. [Source decisions](#source-decisions)
3. [Soft-delete columns (added 2026-04-27)](#soft-delete-columns-added-2026-04-27-per-troys-directive)
4. [Self-review pass 2026-04-27](#self-review-pass-2026-04-27-customers-properties-agencies-transaction_participants-services-technician_) (customers / properties / agencies / participants / services / technician)
5. [Audit log review pass 2026-04-27](#audit_log-review-pass-2026-04-27)
6. [Membership and permission triple, review pass 2026-04-27](#membership-and-permission-triple-review-pass-2026-04-27)
7. [Inspections table conventions (review pass 2026-04-27)](#inspections-table-conventions-review-pass-2026-04-27)
8. [Customer/property dedupe summary](#customerproperty-dedupe-summary-table)
9. [Bill-to-closing workflow](#bill-to-closing-workflow-known-safe-house-pattern)
10. [Future migration considerations](#future-migration-considerations)
11. [Pending v2 schema deltas](#pending-v2-schema-deltas-from-phase-2-pilot-2026-04-26)
12. [Cross-cutting design notes](#cross-cutting-design-notes)
13. [Per-table rationale stubs](#rationale-per-table)
14. [Open questions](#open-questions-tracked-here)

## Permission system architecture (v3.1, added 2026-04-27)

The v3.1 schema additions introduced two-tier RBAC: granular permissions checked at request time, plus permission groups for operational ergonomics. Per-user grants and denies override role defaults. This section captures the architectural decisions made during the v3.1 design pass; full operational details in `06-security-spec.md` S11.

### Why two tiers (granular + groups)

Managing 50 permissions per user is operational overhead. Most users need standard bundles ("all admin", "all view", "all financial"). Group permissions handle the common case while granular permissions remain available for precision.

Real-world cases the two-tier model supports:

- Grant `admin` group to a new operations manager: they get all 8 admin permissions in one assignment.
- Add a new admin capability later: anyone with `admin` automatically gets it (subject to caveat below).
- Grant `admin` to Bob but deny `view.customer.pii`: Bob has 7 of 8 admin permissions plus 14 of 15 view permissions. The deny is explicit and audited.
- Revoke `admin` from a departing employee: clean single-row removal.

The alternative we considered and rejected was role hierarchies (`dispatcher_with_export`, `dispatcher_with_billing_view`, etc.). Sub-role proliferation is a worse problem than multiple permissions per user.

### Storage option B-2 (separate tables, separate columns for kind)

Options considered:

- **A: Synthetic rows in `permissions` with `is_group=true`.** Conflates two concepts. Every consuming query needs to filter by `is_group`. Rejected.
- **B-1: Two tables, single `target_kind` discriminator column.** Slightly more compact, less explicit. Borderline.
- **B-2: Two tables, two nullable target columns with CHECK constraint enforcing exactly-one.** Chosen. Each FK enforced independently; audit log payload distinguishes cleanly between permission and group references; PK can include both columns since CHECK guarantees one is null.
- **C: Hierarchical naming with wildcards (`admin.*`).** Implicit grouping; runtime string-matching changes group membership when permissions are added; bad for audit. Rejected.

B-2 chosen because explicit beats implicit for security-critical data. Two extra reference tables (`permission_groups`, `permission_group_members`) cost almost nothing and produce a cleaner audit trail.

### No nested groups

Groups contain granular permissions only, never other groups. Considered and rejected for v3.1.

Reasons:

- Resolution algorithm complexity grows non-linearly with nesting depth.
- Audit trail ambiguity ("granted via admin, which is in account_admin, which is..." obscures the actual grant).
- Operational simplicity: a user-facing UI showing "this group contains: A, B, C" is straightforward; "this group contains group X (which contains A, B, C) plus group Y (which contains C, D, E with overlap)" is not.

The trade-off lands on `account_admin`: it is a flat superset of `admin` rather than a parent. Documented maintenance rule: "when adding a permission to admin, also add to account_admin." A test enforces the invariant. If maintenance friction proves operationally common, revisit.

### Granular denies always win over group grants

Resolution applies grants then denies. A granular `deny view.customer.pii` removes the permission even if the user has a group grant that would otherwise include it.

**Why:** "specific overrides general" is the principle developers expect. Surprises here become audit holes ("I thought Bob couldn't see PII because we denied it" turns into "the group grant added it back").

Group denies expand to granular denies at resolution time. "Deny export group" is equivalent to denying every `export.*` permission individually.

### Coarse-grained permissions, not fine-grained

50 permissions is the catalog target. Examples: `view.inspection`, `edit.inspection.assign`, `export.customer_list`, `manage.user.permissions`.

The alternative was fine-grained (`view.inspection.status`, `view.inspection.notes`, `view.inspection.payment_status`, hundreds of permissions). Fine-grained gives more flexibility but explodes management overhead and audit log complexity.

Coarse-grained handles the real cases (Katie blocked from PII, Bob granted export rights) without exploding the catalog. Specific-action permissions (`view.pii`, `export.customer_list`, `manage.billing`, etc.) are called out separately for sensitivity tagging.

### Account-shared permissions, account-scoped role defaults

The `permissions` table is account-shared (system-managed reference data). The set of capabilities the codebase checks is a product-level concern, not a per-account customization.

The `role_permissions` table is account-scoped: each account configures which roles get which permissions/groups by default. New accounts seed with the standard role mapping; owner adjusts via `manage.account_config`.

This split lets future licensees configure their own role defaults (a licensee where `dispatcher` should have export rights configures it once, no code change) while the underlying capability list stays consistent.

### Sensitivity flag computed and cached on groups

A group's `sensitive` flag is the OR of contained permissions' `sensitive` flags. The cache lives on `permission_groups.sensitive`; recomputed by application code in the migration that mutates `permission_group_members`.

Why cached: avoid a query-time JOIN every time we check whether a group is sensitive (which happens at every grant operation in the UI flow).

Why not enforced via DB trigger: the catalog mutates only via migrations, which run once. A trigger would add complexity for a narrow benefit. The maintenance contract (a comment block on the column plus a CI test) is sufficient.

### Per-user override expiration

`user_permission_overrides.expiresAt timestamptz nullable` matches the `user_roles.expiresAt` pattern. NULL means permanent. Populated means automatic revocation by an hourly sweep job.

Real-world use: temporary grants (vacation coverage, project-based access) auto-revoke without manual cleanup.

Partial index `user_permission_overrides_expires_idx WHERE expires_at IS NOT NULL` keeps the sweep job query cheap.

### Effective permissions computed at session start, not materialized

We considered a `user_effective_permissions` materialized view or denormalized table. Rejected.

Reasons:

- Cache staleness becomes a permission bug. Stale permissions either grant access that should be revoked (security hole) or deny access that should be granted (UX problem).
- Recomputing at session start is cheap (a few indexed lookups; the resolution algorithm is read-only and simple).
- Cache invalidation events are well-defined (role changes, override changes, group membership changes); the in-memory request-context cache handles the hot path.

Future optimization: if session start latency becomes a problem, pre-compute and cache in Redis with explicit invalidation hooks. Not needed at v3.1 scale.

### Composite PK with nullable target columns

`role_permissions` and `user_permission_overrides` use composite primary keys where two columns (`permission_key`, `group_key`) are nullable, with a CHECK constraint guaranteeing exactly one is non-null per row.

This is a deliberate design pattern, not a mistake. Postgres allows nulls in composite PKs as long as no two rows have identical values across the column set. The CHECK constraint guarantees that two rows differ on at least one of the target columns. The PK distinguishes `(account, role, permission_key=X, group_key=null)` from `(account, role, permission_key=null, group_key=Y)` cleanly.

Alternative considered: a synthetic `id uuid` PK. Rejected because composite PK gives natural uniqueness on the actual identifying tuple and avoids a separate index.

Documented as a comment block on both tables for future developer onboarding.

## Migration design principles (added 2026-04-27 during spec 04 lock)

Two patterns surfaced during the field-mapping spec that apply broadly to any future migration work in this codebase. Captured as principles so they propagate.

### Principle 1: Post-pass derivation over import-time guessing

Whenever a column's value can be derived from related data after a migration import is complete, prefer the post-pass derivation over a guess at import time. Hardcoded defaults are the wrong tool when the data itself can answer the question.

**Example (spec 04, transaction_participants.primaryRole):** the migration script imports agent records with `primaryRole = NULL`. After orders and inspection_participants rows are imported, a second pass counts each participant's `inspection_participants.role_in_transaction` distribution and sets `primaryRole` to the most frequent value. The data itself answers what role the participant typically plays, with no guess required.

**When this applies:**

- The column is a hint or summary derivable from related rows.
- The related rows are imported in the same migration run.
- A wrong import-time guess would mislead until manually corrected.

**When it does not apply:**

- The column is structurally required for downstream FK lookups (cannot be NULL temporarily).
- The derivation depends on data outside the migration scope.

Document the post-pass step in the migration plan when this pattern is used.

### Principle 2: Per-account config for terminology, not code branches

When migration logic depends on per-account operational vocabulary (role flag meanings, custom field names, lookup table values, business-specific defaults), the variation lives in a per-account config object passed to the migration script. NOT in conditional code branches keyed on account identity.

**Example (spec 04, accountRoleMapping):** ISN's role flags (`officestaff`, `callcenter`, etc.) mean different things at different licensees. The migration script accepts an optional `AccountRoleMapping` config that overrides the default mapping. Safe House runs without overrides; a licensee where `callcenter` flagged dispatch staff passes `{ callcenter: 'dispatcher' }`.

**When this applies:**

- The mapping is structural (one ISN value to one v3 value) but the choice varies per account.
- Adding a new licensee should not require a new code branch.
- The default value is reasonable for a generic ISN tenant.

**Pattern:**

```ts
type PerAccountConfig = {
  roleMapping?: AccountRoleMapping;
  fieldNameMapping?: AccountFieldNameMapping;
  lookupOverrides?: AccountLookupOverrides;
  // ... other terminology-sensitive config ...
};
```

The migration script accepts `PerAccountConfig` as input. Defaults baked into the script work for the common case (Safe House and similar). Licensees with diverging operational vocabulary supply overrides.

**Anti-pattern to avoid:** branching on account_id, account name, or licensee tier inside migration logic. That makes the script account-aware in a way that does not scale.

## Architectural overview

The v3 schema is built around three layered concerns. Each layer has its own isolation boundary and its own set of shared resources.

### Layer 1: Account (top-level tenant)

An `account` is the licensing tenant. Today there is one account, ours. The architecture is licensing-ready from the foundation, so future licensees become additional account rows without schema changes.

A user belongs to exactly one account (Pattern 1). Cross-account leak is the most damaging failure mode in the system; row-level security at the database layer plus the INV-1 invariant in the security spec enforce isolation.

### Layer 2: Business (operational unit within an account)

Within an account, work happens inside `businesses`. Today our account has three: Safe House Property Inspections, HCJ Pool Services, Pest Heroes. Each is a row in `businesses` with a type discriminator (`inspection`, `pool`, `pest`). A business has its own users, services, technician availability, and operational records.

A user can belong to multiple businesses within their account via `user_businesses`. Roles are per-business (`user_roles` keyed on user + business + role) so the same human can be `owner` at Safe House and `bookkeeper` at HCJ.

### Layer 3: Customers, properties, transaction participants, agencies (shared within account)

Real-world entities like customers, physical properties, real estate agents, and brokerages exist independently of which business serves them. They are scoped to an account but shared across that account's businesses, with junction tables (`customer_businesses`, `property_businesses`, `agency_businesses`) tracking which businesses have transacted with each entity. This unlocks cross-sell visibility (a Safe House customer is the same record HCJ would service if pool work came up) without duplicating PII.

Transaction participants (realtors, transaction coordinators, escrow officers, lenders, attorneys) live alongside customers as a separate shared entity, distinct from "people who pay us" because their role in a deal is structural, not commercial.

### Audit and security as cross-cutting concerns

`audit_log` is the system-wide append-only journal, scoped to account. Every meaningful action produces an audit entry; reads of sensitive fields produce them too (security spec S5). Forensic correlation via `sessionId` and `requestId` lets us reconstruct a user's actions across an HTTP request and across a session.

Row-level security policies on every account-scoped and business-scoped table enforce isolation at the database layer, not just in the application. Session-variable misconfigurations result in zero rows returned, the safe failure mode.

### Soft-delete pattern

Tables holding PII or operational history carry `deletedAt`, `deletedBy`, `deleteReason` columns and a `deleted_at_idx` index. Hard delete is reserved for retention jobs and explicit admin actions, both audit-logged.

### Naming and modeling conventions

- UUIDs for every primary key. No auto-increment integers.
- All datetime columns are `timestamptz`.
- Enum-shaped columns are `pgEnum` for DB-layer enforcement, with the trade that adding values requires a migration.
- Account-scoped tables carry `account_id` directly. Operational tables inherit account scope through their FK chain rather than denormalizing.
- Composite indexes on hot paths typically lead with `business_id`; cross-account queries are rare and explicit.
- The existing Replit project's column-naming patterns (camelCase TS, snake_case SQL) are preserved.

## Source decisions

## Source decisions

The schema follows from these decision documents and principle specs:

- `specs/06-security-spec.md` (S1-S8 hard requirements; soft-delete in S4)
- `specs/07-scalability-spec.md` (Sc1-Sc7)
- `specs/08-multi-business-extensibility-spec.md` (M1-M6)

If a section here conflicts with those, the principle specs win. This file explains how the constraints land in column-level shape.

Decision documents:

- `decisions/2026-04-26-design-decisions.md` (D1-D5)
- `decisions/2026-04-26-multi-business-architecture.md` (Pattern B, multi-business)

If a section here conflicts with those, the decision docs win. This file explains how the decisions land in column-level shape.

## Soft-delete columns (added 2026-04-27 per Troy's directive)

Following security spec S4, the following tables now carry `deletedAt timestamptz`, `deletedBy uuid references users(id)`, and `deleteReason text`:

- `customers`
- `properties`
- `transaction_participants`
- `inspections` (distinct from operational `cancelledAt`; cancellation is a workflow state, deletion is an admin action)
- `agencies` (kept the `active` boolean as operational hide, deletedAt is the admin-removed signal)

Indexes added: `<table>_deleted_at_idx` on each, since the most common read pattern is `WHERE deleted_at IS NULL`.

Tables that use `status` as a soft-delete signal instead (no deletedAt columns):

- `businesses` (`status='inactive'`)
- `users` (`status='inactive'`)
- `user_businesses` (`status='inactive'`)

Reasoning: these tables hold structural records rather than direct PII rows. The status flag is sufficient and matches existing patterns. We can convert them to deletedAt columns later if a use case requires it without breaking schema, since the operational state moves into a new column rather than removing one.

Tables that explicitly do NOT soft-delete:

- `user_roles`: role grants/revocations are mutations recorded in audit_log; no soft-delete on the row itself.
- `audit_log`: append-only by design. Hard delete only via configured retention job.

## Self-review pass 2026-04-27 (customers, properties, agencies, transaction_participants, services, technician_*)

### A. Agencies are temporarily polymorphic

`agencies` today holds three corporate entity flavors: real estate brokerages (the dominant case), lender institutions (banks where lenders work), and law firms (where attorneys work). Application distinguishes by joining to `transaction_participants.primaryRole`.

This overload is acceptable today because:

- All three are corporate entities with name, address, phone, email.
- We do not need lender-specific fields (NMLS ID) or law-firm-specific fields (bar number, jurisdiction) until bill-to-closing becomes a real workflow.
- The agencies table is small (~5,000 rows at 10x); a future migration to a richer model is cheap.

**Future expansion: an `organizations` table.** When bill-to-closing graduates from "capture in notes and rationale" to "feature with its own UI," we add an `organizations` table parallel to agencies, scoped to account, with a type discriminator. `transaction_participants` gains an optional `organizationId` FK. Agencies can either migrate forward or stay as a real-estate-brokerage-only table. Worked example will land in `08-multi-business-extensibility-spec.md`.

### B. Customer dedupe rule

Hard dedupe: `(account_id, lower(email), lower(display_name))`. Two records with same account + same email + same name are treated as the same customer. Soft suggestion in UI when phone matches but email or name does not. Manual merge for everything else.

Indexes on customers serve both rules: `customers_account_email_idx` and `customers_account_name_idx`. Phone-based matching uses `lower(phone)` ILIKE; not indexed today (phone search is an admin-tool query, not a hot path). Add an index if usage proves it.

Final rule and migration heuristics captured in `04-field-mapping.md` when that doc ships.

### C. Property dedupe rule

Strict match on lowercased, whitespace-normalized `(address1, city, state, zip)` within an account. No third-party validation today.

Known limitations:

- "123 Main St, Unit 4B" vs "123 Main St #4B" become two different rows. Manual merge UI handles them.
- USPS-standardized addresses would solve this, but require a third-party API (USPS, Smarty, Lob). Cost is small; integration friction is real.

Upgrade trigger: when staff report routine merge fatigue, or when migration from ISN surfaces a high collision rate, integrate USPS validation as a normalization step on insert. Document trade.

Index `properties_account_addr_lower_idx` serves the dedupe lookup.

### D. inspector_* renamed to technician_*

Four tables and their associated TS variables, indexes, Zod schemas, types, and audit_log entity_type values renamed:

- `inspector_hours` -> `technician_hours`
- `inspector_time_off` -> `technician_time_off`
- `inspector_zips` -> `technician_zips`
- `inspector_service_durations` -> `technician_service_durations`

Reason: the role is generic across business types. Inspector at Safe House, pool tech at HCJ, pest tech at Pest Heroes are all `technician` role with `roleEnum`. Naming the availability tables after one specific business type (Safe House inspections) creates cognitive overhead when the patterns extend.

**Untouched intentionally:**

- `inspection_inspectors.inspectorId` column. This refers to the human filling the inspector role on a Safe House inspection. The column name reflects the operational role, not the table convention.
- `inspectorOnInspectionRoleEnum`. Same reason.
- `inspections.byInspector` index name. Points to `lead_inspector_id`, an operational role-specific column.

When pool jobs and pest treatments tables land, they will have analogous `pool_job_technicians` and `pest_treatment_technicians` junction tables, NOT `pool_job_inspectors`. The rename matters.

### E. services.category added

Optional `varchar(100)` column. Examples by business type:

- Inspection (Safe House): `Inspection`, `Sampling`, `Reinspection`, `Specialty`
- Pool (HCJ): `Chemical Service`, `Equipment Service`, `Leak Detection`, `Opening / Closing`
- Pest (Pest Heroes): `Termite`, `General Pest`, `Mosquito`, `Wildlife`

Drives UI grouping in service-selection dropdowns and per-category reports. Categorization vocabulary is per-business and lives in `businesses.config` (or as data conventions documented per business). No CHECK constraint or enum because the vocabulary varies by business type.

Partial index `services_business_category_idx` on `(business_id, category)` excludes nulls.

### F. transaction_participants.primaryRole as UI hint

`primaryRole` describes the participant's typical role across transactions. The actual role on a given deal lives on `inspection_participants.role_in_transaction` (and on future `pool_job_participants.role_in_transaction`, `pest_treatment_participants.role_in_transaction`).

Operational use: filtered lists like "show me realtors" or "show me lenders we work with" can read `transaction_participants.primaryRole` directly without joining inspections. The trade is that a participant who plays multiple roles across different deals has only one `primaryRole`; their actual deal participation is always accurate via the junction.

For real estate the convention: `primaryRole` is the role the participant plays most often in our records. UI defaults can override.

## audit_log review pass 2026-04-27

### Forensic correlation columns

Added `sessionId` (varchar 64) and `requestId` (uuid). Both nullable. They turn audit_log from a list-of-events into a graph of correlated events. Without them, reconstructing "what did this user do across this 30-minute window" is unreliable; with them, every action within a request shares a `requestId` and every request within a session shares a `sessionId`.

Partial indexes on both (`WHERE col IS NOT NULL`) keep them cheap when most events have them populated.

### ipAddress switched to inet

Was `varchar(64)`. Now Postgres native `inet` type. Validated at insert (no malformed IPs sneak in), supports IPv4 and IPv6, and enables CIDR operators for forensic queries: `WHERE ip_address << '10.0.0.0/8'` to find all events from a subnet, `WHERE ip_address << inet_client_addr() & '/24'` for impossible-travel detection.

Drizzle exposes `inet` via `drizzle-orm/pg-core`. TypeScript surface is still `string` on read.

### outcome column

New `auditOutcomeEnum`: `success | denied | failed | partial`. Default `success`. Three reasons:

- **denied** logs failed permission checks. An attacker probing for accessible records leaves a clear trail of denied actions tied to their session and request IDs. Without this column, denied events were either dropped or logged as `success`, both wrong.
- **failed** distinguishes runtime failures (validation, FK violation, integration error) from successful actions. Helps support diagnostics.
- **partial** logs bulk operations that succeeded for some rows and failed for others. Details in `changes.metadata`.

### changes payload, shape and size

Application enforces a 64KB max on `changes` payloads. Reasoning:

- A single audit row should not hold a 50MB attachment. Large blobs go in their own table or storage with the audit row referencing them.
- 64KB accommodates the largest realistic before/after snapshot of a row in our schema, plus generous metadata.
- `changesSize` (integer column) records the actual byte count for monitoring. Anomalies (e.g., creeping payload size on a particular endpoint) surface in dashboard queries.

Documented shape:

```
{
  before?: { ...partial or full row snapshot... },
  after?:  { ...partial or full row snapshot... },
  metadata?: { ...action-specific context... }
}
```

For `action='read_sensitive'`, only `metadata` is typically populated (which fields were exposed, how many records). For `action='update'`, both `before` and `after`. For `action='delete'`, only `before`. For `action='export'`, `metadata` carries filter parameters and record count.

### entity_type CHECK constraint

Kept the column as `varchar(50)`. Added a CHECK constraint listing the canonical values. Trade-offs reviewed:

- **pgEnum** would force a migration for every new entity type. Rejected.
- **Free varchar** invites typos. Rejected.
- **CHECK constraint** gives DB-layer enforcement against typos and stale values, with the trade that adding a new entity type is two synchronized edits (CHECK clause + `AUDIT_ENTITY_TYPES` constant). Accepted.

The CHECK clause and the TypeScript constant must stay in sync. A future tooling check could grep both and assert equality.

### Critical invariant INV-1

Documented in the security spec: `audit_log.account_id` MUST match the entity's account_id. Cannot be FK-enforced because entity_id is polymorphic. Application enforces via a single `writeAuditLog(...)` helper and a daily reconciliation job. Direct `db.insert(auditLog)` calls in code review are a red flag. See `06-security-spec.md` Critical invariants section for full enforcement requirements.

## Membership and permission triple, review pass 2026-04-27

### Credentials split out of users

`passwordHash` lived on `users` in v3 initial draft. Per review, it moves to a dedicated `user_credentials` table for these reasons:

- Most reads of `users` do not need credential material. Pulling secrets into memory on every fetch is sloppy.
- Future SSO (Google, Microsoft) and passkey support need their own row shape; one credential per kind per user.
- Credential rotation history is its own concern; a `user_credentials_history` table can land later without touching `users`.
- Read-audit on credentials is mandatory under S5; isolating them simplifies the audit boundary.

`user_credentials` PK is `(user_id, kind)`. Kinds today: `password`. Future: `sso_google`, `sso_microsoft`, `passkey`.

### Login security state in user_security

A dedicated 1:1 table for login-related state: failed-login counters, last-login metadata (timestamp, IP, user agent), lockout, and password-reset enforcement. Reasons:

- High-write columns (every login attempt updates) live separately so they do not bloat the `users` write path.
- Cleaner audit boundary; this entire table is sensitive read.
- Future expansion (geo-anomaly detection, device tracking) lands here without affecting `users`.

IP addresses are PII per GDPR. Marked accordingly. The 10x scale row count equals user count (1:1).

### MFA factors as a separate table

Multi-factor designed in, not bolted on. `user_mfa_factors` lets a user have multiple factors (TOTP + backup codes + WebAuthn). Each factor row is independent.

MFA secrets (TOTP shared secret, encrypted backup codes) are encrypted at the application layer using a key from the secrets store, NOT stored as plaintext or relying on at-rest DB encryption alone. Implementation detail handled in the auth slice.

MFA enforcement policy (required vs optional, per role, per business) is configuration on `accounts.config` and `businesses.config`, not on this table.

### Email verification on users

`users.emailVerifiedAt` (nullable timestamp) replaces "trust whatever email was entered." Null means unverified. The application gates sensitive notifications and password resets through this flag.

Verification flow:

1. User created (or email changed) -> emailVerifiedAt = null.
2. System sends verification link with a single-use token.
3. User clicks link -> emailVerifiedAt = now().

Referenced in security spec S2 as a PII-related verification gate.

### Role expiration

`user_roles.expiresAt` (nullable). Null = permanent. Populated = automatic revocation at expiry by a background sweep job that DELETEs expired rows and writes audit_log entries.

Real-world cases:

- Vacation coverage: "give Maria temp dispatcher role for 2 weeks while Sara is out."
- Project access: "give the contractor viewer access until project Q3 ends."
- License-based access: "grant analytics role until end of trial."

The sweep job runs hourly. Its query is served by `user_roles_expires_at_idx`, a partial index on `expires_at WHERE expires_at IS NOT NULL`.

### is_primary moved out of user_businesses

**Decision (Troy confirm 2026-04-27 14:42 UTC):** `isPrimary` belongs in a future `user_preferences` table, not on `user_businesses`. `user_businesses` is now a pure membership junction.

**Until `user_preferences` table lands, UI fallback rule:**

1. If a user has only one active business membership, that is their landing business.
2. If multiple, the lowest `joinedAt` among `status='active'` rows wins.
3. The fallback is deterministic and documented; if a user wants a different default, they will set it explicitly once `user_preferences` ships.

**Future user_preferences table sketch** (NOT built today):

```ts
export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  primaryBusinessId: uuid("primary_business_id").references(() => businesses.id, { onDelete: "set null" }),
  timeZone: varchar("time_zone", { length: 50 }),
  theme: varchar("theme", { length: 20 }),
  // ... other UI/UX preferences
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

When `user_preferences` lands, migration backfills `primary_business_id` for existing users using the fallback rule above. From that point, the application reads `user_preferences.primary_business_id` first and falls back to the deterministic rule when null.

### Standalone user_id index dropped on user_businesses

The PK is `(user_id, business_id)`. The leading column serves user-side lookups directly. The redundant standalone `(user_id)` index has been removed; reduces write overhead on every membership change.

### user_roles.grantedBy nullability and seed strategy

`grantedBy` is nullable to support system-grant scenarios:

- **Seed:** the first owner of an account is granted `owner` role with `grantedBy=null`. The audit_log entry for this seed event records `userId=null` and a structured `changes` payload with `context='system_seed'`.
- **Automated upgrades:** if a future migration grants a new role en-masse, those rows have `grantedBy=null` and audit_log captures the migration version.
- **Human grants:** populated with the granting user's id.

When reading user_roles for display ("who granted this role"), null renders as "System."

### Account-wide role design note (review item 7)

No `account_roles` table today. A user who is `owner` of every business in their account has one `user_roles` row per business. For our internal account with three businesses, that's three rows per owner. Acceptable.

When a licensee with many businesses produces operational pain (e.g., "add a new business and remember to grant the owner role there too"), we add an `account_roles` table for true account-wide grants. Row count today does not justify it.

## Inspections table conventions (review pass 2026-04-27)

### leadInspectorId is nullable by design

Three real workflow cases require nullability:

1. **Booking-before-assignment.** Client or realtor self-books via portal; inspection lands in `status='scheduled'` without an inspector. Dispatcher assigns later.
2. **Cross-business inheritance.** When this pattern extends to `pool_jobs` and `pest_treatments`, those workflows may not use a single "lead" concept.
3. **Reassignment during reschedule.** A job's inspector can be cleared mid-reschedule, then reassigned in a separate step.

Application logic enforces required-by-status: cannot transition to `confirmed | en_route | in_progress | completed` without a lead. Inspector reassignment goes through `reschedule_history`.

### customerId and propertyId are nullable

- `customerId`: nullable for migration tolerance. Legacy ISN orders may not link cleanly to a customer record (test orders, voided orders, data hygiene gaps). Easier to import with null than to drop or fabricate. New bookings should require a customer.
- `propertyId`: same migration tolerance reason, plus one real workflow: pre-property bookings (e.g., realtor calls in with "client just made an offer, address coming" and we want to hold the slot). Property attaches before inspection day.

Application logic enforces required-by-status: cannot transition to `in_progress | completed` without both. The migration plan documents the population gap and the cleanup pass that backfills wherever ISN data permits.

### Order number generation

**Format:** `${businessPrefix}-${currentYear}-${seq:06d}`. Example: `SH-2026-001234`, `HCJ-2026-000045`.

**Generation strategy:**

- A Postgres `SEQUENCE` per business: `order_number_seq_safehouse`, `order_number_seq_hcj_pools`, etc. Created when the business is created.
- Application code calls `nextval(seqForBusiness)` and formats the result with the business's prefix and the current year.
- The sequence is monotonic and increments forever for that business. Year rollover requires no maintenance job; the year is purely a format string.
- Six-digit padding handles 999,999 per business lifetime. Expand the format trivially when needed.

**Race-free guarantee:** `nextval()` is atomic in Postgres. Concurrent inserts at the same instant get distinct values. No SELECT MAX + 1 anti-pattern.

**Examples over time:**

- Safe House at year 1: `SH-2026-000001`, `SH-2026-000002`, ...
- Safe House next year: `SH-2027-002413` (sequence keeps incrementing).
- Safe House decades on: `SH-2050-728432` (acceptable; six digits accommodate up to 999,999).

**Year-prefixed query:** `WHERE order_number LIKE 'SH-2026-%'` still works for "all 2026 Safe House inspections" reports.

**Migration:** legacy ISN order numbers preserved in `isnReportNumber` if they do not match our format. A fresh `order_number` is generated for each migrated row. The original ISN identifier remains queryable.

### rescheduleCount removed

Denormalized counter columns drift over time as edge-case writes miss the increment. Reschedule count is computed on demand from `reschedule_history` via `COUNT()`. The `(inspection_id)` index on reschedule_history makes the join cheap.

### confirmedAt / initialCompletedAt have corresponding *By columns

- `confirmedBy` is the user who recorded the confirmation. Null when the client self-confirmed via the portal (in which case the audit trail in `audit_log` carries the participant info).
- `initialCompletedBy` is the user who marked the first completion, typically the lead inspector. Distinct from `createdBy` of any later QA-reopen-and-recomplete cycle.

## Customer/Property dedupe summary table

| Entity | Hard rule | Soft rule | Manual |
|---|---|---|---|
| customers | (account_id, lower(email), lower(display_name)) | lower(phone) match | merge UI for everything else |
| properties | (account_id, lower(address1) + city + state + zip, normalized whitespace) | none today | merge UI; future USPS validation |

## Bill-to-closing workflow (known Safe House pattern)

Captured 2026-04-27 from review pass. Not implemented in the scheduling slice; surfaced now so the migration plan and the future payments slice account for it.

**Pattern:** for some real estate transactions, the closing attorney or lender is the financial decision-maker for the inspection invoice. The customer is the buyer (and remains the customer-of-record), but the invoice routes to the closing attorney's office and payment occurs at closing rather than at inspection time.

**Operational consequences:**

- **Invoice routing:** the invoice may be addressed to the closing attorney's office or the lender, not the customer's mailing address.
- **Payment notifications:** the closing entity needs payment status updates, not just the customer.
- **Payment status timing:** the inspection sits in `paymentStatus='unpaid'` for weeks until closing, then transitions directly to `paid` (or `disputed` if closing falls through).
- **Reschedule and cancel implications:** cancelling an inspection where billing routes to closing has different downstream effects than a normal cancel.

**Schema readiness:**

- `transaction_participants` table can hold the lender and attorney (now first-class enum values: `lender`, `attorney`).
- `inspection_participants` junction can flag a participant as the bill-to-closing party.
- Per-inspection invoice-routing override is NOT yet modeled. The payments slice should add either a column on `inspections` (e.g., `invoice_recipient_participant_id` referencing the inspection_participants row) or a separate `inspection_invoice_routing` table.
- `paymentStatus = 'disputed'` (newly added) covers the failed-closing case.

**Action items for downstream work:**

- Migration plan (`05-migration-plan.md`): identify ISN orders that used bill-to-closing historically. Trace via order notes or invoice-routing fields. Migrate the participants correctly.
- Booking flow design: capture bill-to-closing as a flag at intake.
- Payments slice: design invoice-routing model and payment-trigger semantics.

## Future migration considerations

Notes captured during review for action when context demands. Not blocking the current schema lock.

- **`accounts.billingCountry` defaults to `"US"`.** When licensing expands beyond US tenants, the default needs review (probably remove default and require explicit value at insert). For Safe House and likely first-wave licensees, US is correct.
- **`displayOrder` reorder strategy is lazy.** Application computes `MAX(display_order)+1` per account on insert; reorder operations bump subsequent rows in a transaction. If reorders become frequent or contended, consider sparse-gap allocation (`+1000` increments) to reduce write contention. Not necessary at our scale.
- **`on_hold` inspection status convention.** When an inspection is bumped without a new date locked: `status='on_hold'` and `scheduledAt` may stay populated showing the old date for reference, OR be set to a placeholder (e.g., end-of-day far-future). Final convention picked in `04-field-mapping.md` when that doc is drafted.
- **`inspector_hours` and similar availability tables have NO soft-delete.** Hours change frequently and we do not need to retain historical hour windows. If audit becomes a concern (e.g., "what hours did inspector X have on 2026-04-15?"), we add a separate `inspector_hours_history` table rather than soft-delete columns on the main one.

## Pending v2 schema deltas (from Phase 2 pilot, 2026-04-26)

To be applied in the next schema draft pass (after Troy's inline review).

### Add to `inspections`

- `confirmedAt timestamptz` (ISN: `confirmeddatetime`). Captures client confirmation, distinct from creation/scheduling/completion. Operationally meaningful (confirmed orders rarely cancel late). Impossible to backfill cleanly later.
- `initialCompletedAt timestamptz` (ISN: `initialcompleteddatetime`). Captures the FIRST completion event, distinct from `completedAt` which holds the FINAL one. Diverges only when QA reopens an inspection. Useful for QA cycle time analysis.
- `customFields jsonb` (ISN: `controls[]`, filtered). Holds genuine custom data only. Call-center scripts and prompt rows are filtered out at migration. Schema does not constrain shape; per-business config can document expected keys.

### Add as new table: `territories`

ISN surfaces a `costcenter` UUID + `costcentername` on orders (e.g., "Territory A"). Pilot showed 7/8 orders tagged "Territory A," 1 untagged. Augment will probe for additional territories. The schema models territory as first-class per Troy's direction:

```ts
export const territories = pgTable("territories", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  officeId: uuid("office_id").references(() => offices.id),    // optional; territory may span offices
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  active: boolean("active").default(true).notNull(),
  isnSourceId: uuid("isn_source_id").unique(),                 // ISN: costcenter (id)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Then on `inspections`:

```ts
territoryId: uuid("territory_id").references(() => territories.id),  // ISN: costcenter
```

And `inspector_zips` becomes "ZIP coverage within a territory" rather than standing in for territory itself. Add `territoryId` to `inspector_zips`:

```ts
territoryId: uuid("territory_id").references(() => territories.id),  // optional; null = applies across territories
```

If Safe House turns out to have only one territory operationally, the table stays single-row, schema cost is one extra FK column. Acceptable.

### Decisions confirmed by Troy 2026-04-26 22:58 UTC

| Topic | Decision |
|---|---|
| `customFields` shape | jsonb column on `inspections`, not a separate table. ISN's `controls[]` is too messy to normalize. |
| `confirmedAt`, `initialCompletedAt` | Add now to `inspections`. Cheap, captures real ISN signal. |
| Call-center scripts | Do NOT migrate. Filter out at migration. Future "office workflow" module owns scripts, not the inspections data model. |
| Territories | First-class table linked to offices, separate from `inspector_zips`. `inspector_zips` carries optional `territoryId`. |

## Cross-cutting design notes

### ISN status flags → derived `status` field

ISN does not have a single `status` field on orders. Status is the conjunction of 5 string flags: `complete`, `canceled`, `paid`, `signature`, `show`. The v2 schema uses an explicit `status` enum on `inspections` (`scheduled | confirmed | en_route | in_progress | completed | cancelled | no_show`) plus orthogonal axes (`paymentStatus`, `signatureStatus`, `qaStatus`, `reportReleased`).

**Migration responsibility:** a single `derive_status_from_isn_flags()` helper, written once, tested against pilot data, reused across all order migrations. Captured in `specs/05-migration-plan.md` when drafted. The helper takes the 5 ISN flags plus completed/cancelled timestamps and returns one of the v2 status values.

### Field cut list (30% of ISN order surface is dead)

29 fields appeared empty in all 8 pilots. These are the explicit "fields not migrated" list for the migration plan:

| ISN field | Reason |
|---|---|
| `address2` | Empty across pilot. Optional column on v2; will populate if data shows otherwise on augment. |
| `gatecode` | Empty across pilot. Could become a property attribute later if used. |
| `majorcrossstreets` | Empty across pilot. Geocoding makes this redundant. |
| `escrowofficer`, `escrowofficer*` | Safe House does not use escrow workflow per Phase 1 (`/contacttypes/` empty). |
| `insuranceagent`, `policyholder`, `policynumber` | Safe House does not use insurance workflow. |
| `coupons`, `taxes`, `packages` | Not modeled. ISN feature surfaces unused. |
| `contacts` | Different from contact_types; appears empty. Confirm in augment. |
| `referredreason` | Empty. `referreason` is populated; possibly a typo'd duplicate field. |
| `cancelreason`, `cancelreasonstring`, `canceledby`, `canceleddatetime` | Empty in pilot because nothing was cancelled. Augment will pull a cancelled order and confirm. |
| `confirmedby`, `confirmeddatetime` | Empty in pilot because confirmation timestamps not always set. Augment may surface; if so, we will migrate `confirmeddatetime` to v2 `confirmedAt`. |
| `deletedby`, `deleteddatetime` | Empty in pilot. Soft-delete pattern; we use a `status='deleted'` value or a separate audit-driven approach. |
| `inspector4`-`inspector10` | Slots beyond 3 unused. Multi-inspector via junction supports unlimited; no slot ceiling. |
| `buyersagentcontactnotes`, `sellersagentcontactnotes` | Empty in pilot. Agent notes belong on `transaction_participants` if they appear later. |

This list goes verbatim into `04-field-mapping.md` under "fields deliberately not migrated."

### Comms preferences scoped to customer, not order

ISN supports per-order overrides (`sendemailevents`, `sendsmsevents`, `ignore*fordelivery`). Pilot showed they are nearly always `yes`/no-op. The v2 schema models opt-in at the customer level only. Per-order overrides are deferred to a future feature when demand surfaces.

### Outsourcing kept in field-mapping limbo, surfaced later

ISN has a real outsource workflow (`osorder=yes`, `osscheduleddatetime`, `outsourceamount` per fee row). Not modeled in v2 schema for the scheduling slice. Migration will preserve via `customFields` or a dedicated table when the outsource slice happens. Documented as "preserve, surface later."

### Foundation, propertyType, and other UUID lookups

ISN normalizes property metadata (foundation, state, etc.) to lookup tables and references them by UUID. The v2 schema uses controlled-vocabulary `varchar` columns and translates UUIDs to strings at migration. Reasoning:

- The lookup tables are short and stable.
- The UUIDs add no value in our system.
- Translation is one-time.
- Future addition of a foundation type only requires updating the controlled list, not creating a new lookup row.

If a property attribute proves to be high-cardinality, growing, and queried often, we promote it to its own table. Foundation is none of those things.

## Rationale per table

(To be filled in section-by-section as Troy reviews and questions arise.)

### `businesses`
### `users`
### `user_businesses`
### `user_roles`
### `customers`
### `customer_businesses`
### `properties`
### `property_businesses`
### `customer_properties`
### `transaction_participants`
### `agencies`
### `agency_businesses`
### `services`
### `inspector_hours`
### `inspector_time_off`
### `inspector_zips`
### `inspector_service_durations`
### `territories` (pending)
### `inspections`
### `inspection_inspectors`
### `inspection_participants`
### `inspection_services`
### `reschedule_history`
### `audit_log`

## Open questions tracked here

1. Foundation lookup translation: which controlled vocabulary do we use? "slab | crawl | basement | pier_and_beam | other" or something more granular?
2. `propertyType` controlled vocabulary: confirm during augment if more values surface.
3. Generated column for `inspections.scheduledEndAt`: support varies by Drizzle version. Either generated column or computed in queries.
4. Property dedupe strategy: strict on (address1+city+state+zip) lowercased? Smarty/USPS validation on ingest? Decision in `04-field-mapping.md`.
5. Whether Safe House operates with multiple territories (pilot showed only "Territory A"). Augment may surface more.
