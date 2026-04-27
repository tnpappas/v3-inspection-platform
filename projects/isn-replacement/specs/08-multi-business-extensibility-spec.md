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

## Worked example: adding a new business

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

## Open items for spec finalization

1. Polymorphic `reschedule_history` vs per-op `*_reschedule_history` decision.
2. Whether `inspector_hours`, `inspector_time_off`, `inspector_zips` should be renamed to a generic `technician_*` to match the per-business-type term ("inspector" at Safe House, "pool tech" at HCJ).
3. Cross-business reporting surface API design.
4. Account-level vs business-level role hierarchy when `accounts` table lands.
