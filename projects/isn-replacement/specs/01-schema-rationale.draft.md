# Schema Rationale (v2 Draft)

_Companion to `specs/01-schema.draft.ts`. Captures design reasoning, ISN deviations, and decisions awaiting Phase 2/3 validation._

_Status: DRAFT, in progress. Sections fill in as Phase 2 results land and Troy reviews._

## Source decisions

The schema follows from these decision documents:

- `decisions/2026-04-26-design-decisions.md` (D1-D5)
- `decisions/2026-04-26-multi-business-architecture.md` (Pattern B, multi-business)

If a section here conflicts with those, the decision docs win. This file explains how the decisions land in column-level shape.

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
