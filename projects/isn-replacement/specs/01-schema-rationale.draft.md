# Schema Rationale (v2 Draft)

_Companion to `specs/01-schema.draft.ts`. Captures design reasoning, ISN deviations, and decisions awaiting Phase 2/3 validation._

_Status: DRAFT, in progress. Sections fill in as Phase 2 results land and Troy reviews._

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

- Migration plan (`05-migration-plan.draft.md`): identify ISN orders that used bill-to-closing historically. Trace via order notes or invoice-routing fields. Migrate the participants correctly.
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
