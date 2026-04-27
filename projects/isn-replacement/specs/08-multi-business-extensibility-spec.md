# Multi-Business Extensibility Spec

_Status: STUB. Captures the principle-3 requirements set by Troy 2026-04-27 11:52 UTC. Filled out fully after the schema review locks._

## Principle

Pattern B is locked: shared customers and properties across businesses, separated users and operations per business. The architecture must allow adding a fourth or fifth business in the future without schema migration that affects existing businesses.

## Hard requirements

### M1. Adding a business is a row + a config + new tables

To onboard a new business, the changes are:

| Action | Where |
|---|---|
| 1. Insert `businesses` row | The new business record (name, slug, type, status, branding, contact, config). |
| 2. Define business-specific configuration | Either as columns on `businesses` if the field already exists, or as keys in `businesses.config jsonb`. |
| 3. Define role definitions for that business type | Update the `ROLES` constant or document business-type-specific role meaning. |
| 4. Add operational tables specific to the business | E.g., `pool_jobs` for HCJ, `pest_treatments` for Pest Heroes. Same pattern as `inspections`. |
| 5. Add operational junction tables | `pool_job_inspectors`, `pool_job_participants` (if applicable), `pool_job_services`. |
| 6. Add business-specific RLS policies on the new operational tables | Same pattern as `inspections`. |

**No changes to shared tables.** `customers`, `properties`, `agencies`, `users`, `transaction_participants` continue to exist as-is. The new business uses them via existing junctions (`customer_businesses`, `property_businesses`, `agency_businesses`, `user_businesses`).

### M2. Operational tables follow a consistent pattern

Every business-type-specific operational table satisfies:

```
business_id           uuid NOT NULL FK to businesses    -- isolation
order_number          varchar UNIQUE                    -- human-readable identifier
isn_source_id         uuid                              -- migration provenance, optional
scheduled_at          timestamptz NOT NULL              -- when the work happens
duration_minutes      integer                           -- expected duration
status                varchar                           -- business-type-specific enum
customer_id           uuid FK to customers              -- the paying party
property_id           uuid FK to properties             -- the location
fee_amount            decimal(10,2)                     -- the price
created_at, updated_at, created_by, updated_by          -- standard audit columns
deleted_at, deleted_by, delete_reason                   -- soft-delete columns (S4)
```

Plus business-specific columns and a `custom_fields jsonb` for further extension.

The companion junctions follow the inspections pattern:

```
{op}_inspectors / {op}_technicians   -- assigned users (lead + secondary)
{op}_participants                    -- if the op involves transaction participants
{op}_services                        -- line items
```

Reschedule history can either be a per-op table (`pool_job_reschedule_history`) or a shared `reschedule_history` with a polymorphic `entity_type` column. Decision deferred to first non-Safe-House operational slice.

### M3. Per-business customization without shared-table NULLs

Examples surfaced from the three businesses:

- HCJ pool jobs need `pool_size_gallons`, `pool_type` (in-ground / above-ground), `chemicals_added`.
- Pest Heroes treatments need `treatment_type` (general, termite, mosquito), `chemicals_used`, `infestation_severity`.
- Safe House inspections need property metadata that already lives on `properties` plus `inspection_type`, `square_feet`, etc.

**These business-specific fields go in business-specific operational tables**, NOT in shared-column NULLs across operational types.

If a field is genuinely shared across business types (e.g., "weather conditions on day of service"), it can live on shared columns. The default is business-specific.

The `custom_fields jsonb` column on each operational table is for **per-tenant per-business customization within a business type**, not for cross-business-type difference. (E.g., a future inspection company we license to needs a "year built" field on inspections that Safe House does not. That goes in `inspections.custom_fields`. Not in shared columns.)

### M4. Cross-business queries are explicit

The default query pattern is single-business: every query carries `business_id`, every list is scoped to one business, every UI surface shows one business at a time.

Cross-business reporting is a deliberate use case, served by:

- The shared `customers` and `properties` tables: trivially "show all activity for this customer across all businesses they have used."
- The `customer_businesses` and `property_businesses` junctions, which surface "which businesses has this customer used."
- A future explicit `cross_business_reports` API surface that an owner can call.

No accidental cross-business queries. RLS enforces this at the database layer (S1).

### M5. Business-scoped permissions

The `user_roles` junction is keyed on `(user_id, business_id, role)`. The same role in different businesses can mean different things. "operations_manager at Safe House" is not "operations_manager at HCJ." Permission checks always include the business context.

The cross-business "owner" role exists in ALL businesses the user is assigned to as `owner`. There is no global owner role. (When the deferred `accounts` table lands, account-level owner becomes a thing, but that is outside the per-business model.)

### M6. Future business types beyond service businesses

Today's three businesses are all service-based. The architecture must not prevent future business types like retail (an e-commerce sibling), consulting (project-based), or licensed SaaS (subscription).

Implications:

- `businesses.type` is a varchar, not a hard enum. Adding a new type requires no migration.
- Operational tables are business-type-specific, so a retail or SaaS business adds its own (`retail_orders`, `saas_subscriptions`) without affecting service businesses.
- Shared tables (`customers`, `properties`, `users`) are general enough to absorb non-service contexts. (A `properties` row may be misnamed for retail; we will rename or add a sibling `locations` table when it becomes a real need.)
- The role system generalizes: ROLES contains `owner`, `operations_manager`, `technician` (service-type-specific term), `client_success`, `bookkeeper`, `viewer`. New business types add their own role names.

**Extensibility boundary:** the architecture supports new service-business types out of the box. Non-service business types may require minor refactors of shared tables (e.g., adding a `locations` table parallel to `properties`). Not blocked, but not free.

## Layered worked examples (added 2026-04-27)

The v3 schema has three layers: account, business, shared-within-account entities. Adding a new BUSINESS within an existing account is one shape of expansion. Adding a new ACCOUNT (a licensee) is a different, larger shape. Both are documented below.

## Worked example 1: adding a new account (licensing flow)

Scenario: Acme Inspection Services in Florida licenses our platform.

Steps:

1. **Insert the account row.**

   ```sql
   INSERT INTO accounts (id, name, slug, status, plan_tier,
                         billing_email, billing_name, billing_address1, billing_city, billing_state, billing_zip,
                         config)
   VALUES (gen_random_uuid(),
           'Acme Inspection Services',
           'acme-inspect',                          -- globally unique
           'active',
           'starter',                               -- plan tier (vs 'internal' for our account)
           'billing@acmeinspect.com',
           'Acme Inspection Services LLC',
           '100 Main St',
           'Tampa', 'FL', '33601',
           jsonb_build_object(
             'branding', jsonb_build_object('productName', 'Acme Inspect'),
             'security', jsonb_build_object('requireMfaForOwners', true),
             'licensing', jsonb_build_object('contractStartDate', '2026-05-01', 'seatLimit', 25)
           ));
   ```

2. **Provision the seed user (the first owner).**

   ```sql
   INSERT INTO users (id, account_id, email, display_name, status)
   VALUES (gen_random_uuid(), <accountId>, 'owner@acmeinspect.com', 'Acme Owner', 'invited');
   ```

   The seed user has `status='invited'`. They receive an enrollment email with a single-use token. On enrollment, they set their password and `users.status` flips to `active`. `emailVerifiedAt` populates as part of the same flow.

3. **Provision the seed business.**

   ```sql
   INSERT INTO businesses (id, account_id, name, slug, type, status, display_order, created_by, last_modified_by)
   VALUES (gen_random_uuid(), <accountId>,
           'Acme Property Inspections', 'acme-property',  -- unique within account
           'inspection', 'active', 1, <ownerId>, <ownerId>);
   ```

4. **Wire up the seed user's membership and roles.**

   ```sql
   INSERT INTO user_businesses (user_id, business_id, status) VALUES (<ownerId>, <businessId>, 'active');
   INSERT INTO user_roles (user_id, business_id, role, granted_by) VALUES (<ownerId>, <businessId>, 'owner', NULL);
   ```

   `granted_by=NULL` because this is a system seed. The audit_log entry for the seed event records `userId=NULL` and a `metadata.context='system_seed'` payload.

5. **Provision the order_number sequence for the business.**

   ```sql
   CREATE SEQUENCE order_number_seq_acme_property START 1;
   ```

   Format: `${businessPrefix}-${currentYear}-${nextval():06d}`. Application code reads `businesses.config` (or a dedicated prefix column when added) to find the prefix.

6. **Verify RLS isolation.**

   Run a test query as the new owner; verify they cannot see any data from any other account. Add a smoke test to the deployment pipeline that asserts the new account's RLS works in both directions.

7. **Send the enrollment email.**

That is the complete account onboarding flow. **No schema change is required to onboard a new account.** All shared tables (customers, properties, agencies, transaction_participants) start empty for the new account and accumulate as that account does business.

When the licensee adds their second business (e.g., Acme adds a pest service):

- Repeat step 3 with `type='pest'` for `businesses`.
- Add `user_businesses` rows for staff who serve pest.
- Add `user_roles` rows for those staff.
- Provision the order_number sequence for the new business.
- No further schema change.

## Worked example 2: adding a new business to an existing account

Scenario: Safe House decides to launch a fourth business, "Coastal Junk Removal."

Steps:

1. **Insert businesses row:**

```ts
INSERT INTO businesses (name, slug, type, status, ...)
VALUES ('Coastal Junk Removal', 'coastal-junk', 'junk_removal', 'active', ...);
```

2. **Define business-type configuration in `businesses.config`:**

```json
{
  "operating_hours_default": "08:00-17:00",
  "minimum_job_size_cu_yd": 1,
  "service_radius_miles": 30
}
```

3. **Define roles. The existing role list covers it:**

- `owner`, `operations_manager`, `dispatcher`, `technician` (junk removal worker), `client_success`, `bookkeeper`, `viewer`.
- No new ROLES constant entries needed.

4. **Add operational tables:**

```ts
export const junkRemovalJobs = pgTable("junk_removal_jobs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessId: uuid("business_id").notNull().references(() => businesses.id),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(120),
  status: varchar("status", { length: 50 }).notNull().default("scheduled"),
  customerId: uuid("customer_id").references(() => customers.id),
  propertyId: uuid("property_id").references(() => properties.id),
  feeAmount: decimal("fee_amount", { precision: 10, scale: 2 }).notNull(),
  estimatedCubicYards: integer("estimated_cubic_yards"),  // business-specific
  truckSize: varchar("truck_size", { length: 50 }),       // business-specific
  customFields: jsonb("custom_fields").default(sql`'{}'::jsonb`).notNull(),
  // standard audit + soft-delete columns
});

export const junkRemovalJobInspectors = pgTable("junk_removal_job_workers", { ... });
export const junkRemovalJobServices = pgTable("junk_removal_job_services", { ... });
```

5. **Add RLS policies on the new operational tables**, mirroring inspections:

```sql
CREATE POLICY junk_removal_jobs_business_isolation
  ON junk_removal_jobs USING (business_id = current_setting('app.current_business_id')::uuid);
```

6. **Add the new business to `user_businesses` for relevant staff**, with appropriate roles in `user_roles`.

**Total: zero changes to shared tables. Zero changes to existing operational tables. Zero migration impact on Safe House, HCJ, or Pest Heroes.**

This is the test the architecture must pass. If at any point during the schema review we find we cannot add a new business without modifying shared columns, the design is broken and we redesign.

## Schema-level checklist (per-table)

Every table in `specs/01-schema.ts` carries a header comment confirming evaluation:

```
// Multi-business: [shared | scoped | junction], [how it adapts when a new business is added]
```

## Future expansion: organizations table

Review decision 2026-04-27: lender institutions and law firms today live in the `agencies` table alongside real estate brokerages. This is a temporary polymorphism captured in the schema rationale doc and noted in the `agencies` table comment block.

When bill-to-closing graduates from "capture in notes and rationale" to "feature with its own UI," the polymorphism is replaced by an `organizations` table with a type discriminator.

### Sketched future schema

```ts
export const organizationTypeEnum = pgEnum("organization_type", [
  "real_estate_brokerage",
  "lender_institution",
  "law_firm",
  "escrow_company",
  "insurance_company",
  "other",
]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  type: organizationTypeEnum("type").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  // ... shared corporate fields ...
  // type-specific fields by convention land in `details jsonb` to avoid NULL columns:
  details: jsonb("details").default(sql`'{}'::jsonb`).notNull(),
  // ...
});
```

### Worked migration to introduce organizations

1. Create `organizations` table.
2. For each `agencies` row, INSERT a corresponding `organizations` row with `type='real_estate_brokerage'`, copying name, address, contact fields, and `details` populated from the agency's existing data.
3. Add `organization_id` column to `transaction_participants` (nullable) referencing `organizations.id`.
4. Backfill `transaction_participants.organization_id` from the agency_id linkage where `agencyId IS NOT NULL`.
5. For new lenders and attorneys, application creates `organizations` rows with `type='lender_institution'` or `type='law_firm'` and links via `organization_id` on the participant.
6. Decide on agencies' future: either retire the table (migrate all rows to organizations and drop) or keep as a real-estate-only narrower view backed by a partial index on organizations.

Additive change. No breaking changes to existing operational records.

The details jsonb column carries type-specific fields:

- For `lender_institution`: NMLS ID, branch info, primary contact name.
- For `law_firm`: bar number(s), jurisdictions, paralegal contact name.
- For `real_estate_brokerage`: license number, MLS affiliations.

When a details key proves universal across rows, promote it to a real column.

## Open items for spec finalization

1. Polymorphic `reschedule_history` vs per-op `*_reschedule_history` decision. Today the schema has a single `reschedule_history` scoped to inspections only. When pool_jobs and pest_treatments land, decide between extending reschedule_history with a polymorphic entity_type column or creating per-op tables.
2. ~~Whether `inspector_hours`, `inspector_time_off`, `inspector_zips` should be renamed to a generic `technician_*`~~ — RESOLVED 2026-04-27. Renamed to `technician_*` in v3.
3. Cross-business reporting surface API design.
4. Account-level vs business-level role hierarchy. Today no `account_roles` table; an account-wide owner has one `user_roles` row per business in their account. When pain warrants, add `account_roles` for true account-wide grants. Documented in schema rationale.
