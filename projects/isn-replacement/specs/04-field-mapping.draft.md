# Field Mapping: ISN to v3

_Status: DRAFT, awaiting Troy's review. Locks alongside spec 02, 03, 05 in the building phase._

_Companion to `specs/01-schema.ts` (v3 schema, locked at git tag `v3-schema-locked`)._

This document is the dictionary every other building-phase deliverable references. The migration plan, migration scripts, API contract, and user stories all assume this mapping is correct.

## Table of contents

1. [Conventions](#conventions)
2. [Source fields covered](#source-fields-covered)
3. [/me, /offices, /companykey, /build, /time](#me-offices-companykey-build-time)
4. [/users](#users)
5. [/ordertypes](#ordertypes)
6. [/clients (customers)](#clients-customers)
7. [/agents and /escrowofficers and /insuranceagents (transaction participants)](#agents-and-escrowofficers-and-insuranceagents-transaction-participants)
8. [/order detail (the big one)](#order-detail-the-big-one)
9. [/order/fees](#orderfees)
10. [/order/history (audit log import)](#orderhistory-audit-log-import)
11. [Fields deliberately not migrated](#fields-deliberately-not-migrated)
12. [v3 fields ISN does not have](#v3-fields-isn-does-not-have)
13. [Helper signatures](#helper-signatures)
14. [Open questions](#open-questions)

## Conventions

- ISN fields use ISN's actual JSON keys (lowercase, sometimes oddly named like `sendSMS`).
- v3 columns use the camelCase Drizzle property names.
- "ISN type" reflects what the API returns. Many booleans are stringly typed (`"yes"` / `"no"` / `"true"`); migration coerces.
- "Always populated" / "sometimes" / "never (Safe House)" reflect Phase 1 + Phase 2 sample data.
- PII examples use synthetic placeholders (`<EMAIL>`, `<NAME>`, `<UUID>`, `<PHONE>`) per the building-phase rule.
- Where a field is dropped (cut), the cut list at the bottom carries the rationale.
- Where a v3 column has no ISN counterpart, the "v3 fields ISN does not have" section explains.

## Source fields covered

From the discovery phase:

- `/me` (1 record)
- `/offices` (1 record)
- `/users` (296 records, 33 distinct fields)
- `/ordertypes/` (27 records, 8 distinct fields)
- `/orders` list (stub: 3 fields)
- `/order/{id}` detail (15 sample records, 97 distinct fields)
- `/order/fees/{id}` (embedded in order detail as `fees[]`)
- `/order/history/{id}` (5 samples, 42 distinct change-tracked field labels)
- `/agents` list (stub: 3 fields; full agent shape inferred from order detail and ISN spec)
- `/clients` list (not yet crawled; mapping based on ISN spec and order detail's `client` reference)
- `/escrowofficers`, `/insuranceagents` (not crawled; Safe House does not use; mapping defined for completeness)

## /me, /offices, /companykey, /build, /time

| ISN field | ISN type | v3 column | Notes |
|---|---|---|---|
| `/me.id` | UUID | `users.isnSourceId` | Preserved through migration for back-reference. |
| `/me.username` | string | `users.username` | Kept for migration-time login compatibility. |
| `/me.firstname` | string | `users.firstName` | |
| `/me.lastname` | string | `users.lastName` | |
| `/me.displayname` | string | `users.displayName` | Fallback to `"{first} {last}"` if null. |
| `/me.emailaddress` | string | `users.email` | Lowercased on insert. |
| `/me.phone` | string | `users.phone` | |
| `/me.mobile` | string | `users.mobile` | |
| `/me.address1` | string | `users.address1` | Trim trailing whitespace on insert. |
| `/me.address2` | string | `users.address2` | |
| `/me.city` | string | `users.city` | Trim trailing whitespace. |
| `/me.stateabbreviation` | string | `users.state` | We use the abbreviation directly; ISN's UUID `state` field is dropped. |
| `/me.zip` | string | `users.zip` | |
| `/me.county` | string | `users.county` | |
| `/me.license` | string | `users.license` | |
| `/me.licensetype` | string | `users.licenseType` | |
| `/me.bio` | string | `users.bio` | |
| `/me.photourl` | string | `users.photoUrl` | URL points at `v3.isnbin.com`; rehosted on our asset host on migration (job out of scope for first pass). |
| `/me.sendSMS` | string `"true"`/`"false"` | `users.smsOptIn` | Coerced via `coerceIsnBoolean()`. |
| `/me.modified` | ISO datetime | `users.updatedAt` | |
| `/me.inspector`, `owner`, `manager`, `officestaff`, `callcenter`, `thirdparty` | string `"Yes"`/`"No"` | `user_roles.role` | One row per `Yes` flag. Mapping: `inspector`→`technician`, `owner`→`owner`, `manager`→`operations_manager`, `officestaff`→`dispatcher` (best-fit; confirm during user audit), `callcenter`→`client_success` (best-fit), `thirdparty`→`viewer`. Mapping captured in user audit step of migration plan. |
| `/me.show` | string `"Yes"`/`"No"` | `users.status` | `Yes` → `active`; `No` → `inactive`. |
| `/me.zips` | array of string | `technician_zips` rows | One row per ZIP for users where `inspector="Yes"`. Default `priority=1`. |
| `/me.state` | UUID | (dropped) | We use `stateabbreviation` directly; ISN's state-UUID lookup table is not migrated. |
| `/me.fax` | string | (dropped) | Always empty in sampled users. |
| `/me.ipaccesskey`, `ipsecretkey` | string/null | (dropped) | Per security spec S6, secrets do not live in schema columns. |
| `/offices.id` | UUID | `businesses.id` (Safe House) | The single ISN office becomes the Safe House `businesses` row. |
| `/offices.name` | string | `businesses.name` | |
| `/offices.slug` | string | `businesses.slug` | We rename to `safehouse` for cleanliness; original slug is `safehousepropertyinspections`. Both work as URL-safe; choose `safehouse` to match account directive. |
| `/offices.address` | string | `businesses.address1` | Trim. |
| `/offices.city`, `state`, `zip`, `county` | string | `businesses.city/state/zip` (no county column) | County dropped at business level. |
| `/offices.latitude`, `longitude` | float | (dropped at business level) | Geo lives on properties, not on the business itself. |
| `/offices.manager`, `manageremail` | string | (dropped at business level) | Manager identity is captured via `user_roles` (the user with role=`operations_manager`), not as a denormalized column. |
| `/offices.phone`, `fax`, `url` | string | `businesses.phone/website` (fax dropped) | Trim trailing whitespace on email. |
| `/offices.helpdeskid` | int | (dropped) | Unused. |
| `/offices.show` | bool | `businesses.status` | `true`→`active`. |
| `/companykey` | string | (no column) | Used during migration as a sanity check (`safehouse`). |
| `/build` | string | (no column) | Logged in migration audit, not stored. |
| `/time` | datetime | (no column) | Used at migration runtime to compute clock skew between ISN server and our server. |

## /users

Same field set as `/me`. Each row maps to a `users` row in our seed account, plus zero or more `user_roles` rows per the role flag conversion. See `/me` mapping above.

## /ordertypes

| ISN field | v3 column | Notes |
|---|---|---|
| `id` | `services.isnSourceId` | |
| `office` | (dropped) | Replaced by `services.businessId` referencing the Safe House `businesses` row. |
| `name` | `services.name` | |
| `description` | `services.description` | |
| `publicdescription` | `services.publicDescription` | |
| `sequence` | `services.sequence` | |
| `show` | `services.active` | `"yes"`→`true`. |
| `modified` | `services.updatedAt` | |

**Migration note:** ISN has 27 ordertype rows but only 16 active (`show=yes`). 5 are duplicate `Reinspection` entries; 1 is the literal warning row `"******Please don't use any of the inspection types below this line******"`. Migration plan includes a cleanup pass: import all 27 with `active` set per their show flag, but the warning row is filtered out entirely (not migrated). Duplicates are imported as-is for traceability and tagged in `services.description` as `[duplicate, retired]` for staff to decide. **No `defaultDurationMinutes` value comes from ISN; migration sets all to 180 minutes (3 hours) and flags for staff to adjust per service.**

`services.category` is NEW (no ISN counterpart) and left null on migration. Operations populates after import.

## /clients (customers)

ISN fields inferred from the ISN spec (we did not deep-crawl `/clients` in Phase 2). Mapping below is the migration target shape; expect minor corrections during the implementation pass.

| ISN field | v3 column | Notes |
|---|---|---|
| `id` | `customers.isnSourceId` | Preserved. `customers.isnSourceType = 'client'`. |
| `firstname` | `customers.firstName` | |
| `lastname` | `customers.lastName` | |
| `displayname` | `customers.displayName` | Fallback to `"{first} {last}"`. |
| `emailaddress` | `customers.email` | Lowercased. |
| `phonemobile` | `customers.phoneMobile` | |
| `phonehome` | `customers.phoneHome` | |
| `phonework` | `customers.phoneWork` | |
| `address1`, `address2`, `city`, `state` (UUID), `stateabbreviation`, `zip` | `customers.address1/.../zip` | Use `stateabbreviation`. |
| `notes` | `customers.notes` | Free text. |
| `sendSMS` | `customers.smsOptIn` | Coerce. |
| `sendemail` (if present) | `customers.emailOptIn` | Coerce; default true if not present. |
| `modified` | `customers.updatedAt` | |
| `show` | `customers.status` | `Yes`→`active`. |

**Account scoping:** every imported customer gets `accountId = <Safe House account id>`. Cross-business linkage to Safe House is via the `customer_businesses` junction (one row per imported customer, `firstSeenAt` and `lastActivityAt` derived from earliest/latest related order's createdAt and modified).

**Dedupe rule (per schema rationale):** hard match on `(account_id, lower(email), lower(displayName))`. Two ISN client rows with the same email + name collapse into one v3 customer; the canonical row keeps the more recent `modified` timestamp; the other ISN id goes into a migration log for traceability.

## /agents and /escrowofficers and /insuranceagents (transaction participants)

All three ISN entity types map into the single `transaction_participants` table.

| ISN field | v3 column | Notes |
|---|---|---|
| `id` | `transaction_participants.isnSourceId` | |
| `agency` (UUID) | `transaction_participants.agencyId` | Joined via `agencies.isnSourceId` lookup. |
| `firstname` | `firstName` | |
| `lastname` | `lastName` | |
| `displayname` | `displayName` | |
| `emailaddress` | `email` | Lowercased. |
| `phone` | `phone` | |
| `mobile` | `mobile` | |
| `notes` | `notes` | |
| `modified` | `updatedAt` | |
| `show` | `status` | |

**`isnSourceType` on each row:**

- `/agents` → `transaction_participants.isnSourceType = 'agent'`, `primaryRole` defaults to `buyer_agent` (best guess; corrected by usage in `inspection_participants`).
- `/escrowofficers` → `isnSourceType = 'escrowofficer'`, `primaryRole = 'escrow_officer'`.
- `/insuranceagents` → `isnSourceType = 'insuranceagent'`, `primaryRole = 'insurance_agent'`.

**For agent/escrow/insurance items that ISN does not surface but Safe House uses (lender, attorney):** these only appear via custom workflow at order intake. Migration does not pre-populate them; they get added as bill-to-closing inspections come in.

**Agencies (separate from participants) come from a denormalized field on agents.** ISN agent records carry an `agency` UUID pointing at an `/agencies` resource. Migration reconstructs `agencies` rows from the union of distinct agency UUIDs across all agent records.

| ISN agency field | v3 column |
|---|---|
| `id` | `agencies.isnSourceId` |
| `name` | `agencies.name` |
| `phone` | `agencies.phone` |
| `email` | `agencies.email` |
| `address`, `city`, `state`, `zip` | `agencies.address/city/state/zip` |
| `notes` | `agencies.notes` |
| `show` | `agencies.active` |

`agency_businesses` junction populated with one row per migrated agency tied to the Safe House business.

**Polymorphism note (per schema rationale A):** today, `agencies` holds real estate brokerages exclusively. Future bill-to-closing flow will add lender institutions and law firms as `agencies` rows (or graduate to the `organizations` table per spec 08). Migration does not pre-create those.

## /order detail (the big one)

The order endpoint returns 97 fields. Mapping by category.

### Identity and source

| ISN field | v3 column | Notes |
|---|---|---|
| `id` | `inspections.isnSourceId` | UUID preserved. |
| `oid` | `inspections.orderNumber` | ISN format is integer (e.g., 37008). v3 format is `SH-YYYY-NNNNNN` per the per-business sequence strategy. **Migration: import ISN orders preserving their oid in `isnReportNumber` (see below); generate fresh v3 `orderNumber` via the per-business Postgres sequence.** Do NOT re-use ISN's `oid` as our `orderNumber`. |
| `reportnumber` | `inspections.isnReportNumber` | Free text like `"1132 - 042426"`. Preserve verbatim. |
| `office` | (dropped at row level; replaced by `businessId`) | |
| `modified` | `inspections.updatedAt` | |
| `createddatetime` | `inspections.createdAt` | Parse via `parse_isn_datetime()` (handles unzoned-as-Pacific). |
| `createdby` | `inspections.createdBy` | Lookup via `users.isnSourceId`. |

### Scheduling

| ISN field | v3 column | Notes |
|---|---|---|
| `datetime` | `inspections.scheduledAt` | Parse as Pacific local; convert to UTC. |
| `datetimeformatted` | (dropped) | Display string; recomputed in v3 from `scheduledAt`. |
| `duration` | `inspections.durationMinutes` | |
| `scheduleddatetime` | (dropped) | "When was the schedule set" event; this lives in audit_log via `/order/history` import. |
| `scheduledby` | (dropped) | Same; audit log captures. |
| `osscheduleddatetime` | (dropped) | Outsource scheduled timestamp; outsource not in scope for scheduling slice (preserve via `customFields` in migration if outsource flag is set). |
| `osorder` | `inspections.customFields.osorder` | Boolean flag; outsource workflow lives in customFields until it gets its own slice. |
| `confirmeddatetime` | `inspections.confirmedAt` | Empty in pilot data; populated when client confirms. |
| `confirmedby` | `inspections.confirmedBy` | |
| `completeddatetime` | `inspections.completedAt` | |
| `completedby` | (dropped at column level; reconstructed from history if needed) | The "completed by" actor is an event in audit_log via history import. The column is not on `inspections` in v3. |
| `initialcompleteddatetime` | `inspections.initialCompletedAt` | |
| `initialcompletedby` | `inspections.initialCompletedBy` | |
| `deleteddatetime` | `inspections.cancelledAt` | Per platform issue #9: ISN's "cancel" overloads delete. Treat as cancellation. |
| `deletedby` | `inspections.cancelledBy` | Same. |
| `cancelreason`, `cancelreasonstring`, `canceledby`, `canceleddatetime` | (dropped, all empty) | The `canceled` flag itself is unused at Safe House; cancellation goes through delete. |

### Status flags (the multi-axis mess)

| ISN field | v3 column | Notes |
|---|---|---|
| `complete` | derived | Used in `derive_status_from_isn_order()`. |
| `canceled` | (dropped) | Unused at Safe House. |
| `paid` | `inspections.paymentStatus` | `"yes"`→`paid`, `"no"`→`unpaid`. Partial/refunded/disputed not represented in ISN; v3 expands. |
| `signature` | `inspections.signatureStatus` | `"yes"`→`signed`, `"no"`→`unsigned`. |
| `show` | (used in derive_status, then dropped) | Combined with `deleteddatetime` to identify cancellation. |

**`inspections.status` derivation** via `derive_status_from_isn_order()`:

```
if deleteddatetime: 'cancelled'
elif complete='yes': 'completed'
elif confirmeddatetime: 'confirmed'
elif scheduleddatetime: 'scheduled'
else: 'scheduled'  # fallback
```

`inspections.qaStatus` defaults to `not_reviewed` for migrated orders. Application layer can flip if QA process surfaces it.

### People

| ISN field | v3 column | Notes |
|---|---|---|
| `client` (UUID) | `inspections.customerId` | Lookup via `customers.isnSourceId`. Null tolerated for migration (some legacy orders may not link). |
| `inspector1` | `inspections.leadInspectorId` | Lookup via `users.isnSourceId`. |
| `inspector2` ... `inspector10` | `inspection_inspectors` rows | One row per populated slot, `role='secondary'`. Slot 1 is the lead and lives on the inspection row, not the junction. |
| `inspector1requested` ... `inspector10requested` | (dropped) | `requested` flags drop; if needed for analytics, captured in audit_log via history import. |
| `buyersagent` (UUID) | `inspection_participants` row, `role_in_transaction='buyer_agent'` | |
| `sellersagent` (UUID) | `inspection_participants` row, `role_in_transaction='listing_agent'` | |
| `escrowofficer`, `insuranceagent`, `policyholder`, `policynumber` | (dropped, all empty at Safe House) | |
| `buyersagentcontactnotes`, `sellersagentcontactnotes` | (dropped, all empty) | Notes on participants belong on `transaction_participants.notes`, not on the inspection. |
| `referreason` | `inspections.customFields.referReason` | UUID into a lookup table we do not migrate; preserve the UUID for traceability. |
| `referredreason` | (dropped) | Always empty; likely a typo'd duplicate of `referreason`. |

### Property (now lives on `properties` shared table)

The order's property metadata maps into a `properties` row, with `inspections.propertyId` referencing it.

| ISN field | v3 column on properties | Notes |
|---|---|---|
| `address1` | `address1` | Required. |
| `address2` | `address2` | Always empty in sampled data, but mapped. |
| `city` | `city` | |
| `state` (UUID) | (dropped) | Use `stateabbreviation`. |
| `stateabbreviation` | `state` | |
| `zip` | `zip` | |
| `county` | `county` | |
| `latitude` | `latitude` | |
| `longitude` | `longitude` | |
| `mapurl` | (dropped) | Recomputed from lat/long in v3 if needed. |
| `gatecode`, `majorcrossstreets` | (dropped, always empty) | |
| `squarefeet` | `squareFeet` | ISN type is string (e.g., `"1712"`); coerce to integer. |
| `yearbuilt` | `yearBuilt` | Same coercion. |
| `foundation` (UUID) | `foundation` (varchar) | UUID translated to controlled vocabulary string at migration time via foundation lookup table. |
| `propertyoccupied` | `occupancy` | Map: `"yes"`→`'occupied'`, `"no"`→`'vacant'`. |
| `utilitieson` | `inspections.customFields.utilitiesOn` | Operational hint; not a property attribute. Preserved on the inspection. |
| `salesprice` | `inspections.customFields.salesPrice` | Always 0 in pilot; preserve where populated. |
| `propertyType`, `bedrooms`, `bathrooms` | (no ISN counterparts; v3 columns added) | Left null on migration. |

**Property dedupe (per schema rationale C):** strict match on lowercased + whitespace-normalized `(address1, city, state, zip)` within the account. Multiple ISN orders at the same address collapse to one `properties` row.

### Finance

| ISN field | v3 column | Notes |
|---|---|---|
| `totalfee` | `inspections.feeAmount` | ISN is string (e.g., `"622.95"`); coerce to decimal. |
| `fees[]` (array of 25 fee items) | `inspection_services` rows | One row per fee where `amount != 0`. See `/order/fees` section. |
| `coupons`, `taxes`, `packages` | (dropped, all empty) | |
| `services[]` (array of `{uuid, name}`) | (dropped) | These are ISN's links to ordertypes used for the order. The fee rows are the source of truth for what was charged; `services[]` is denormalized and not authoritative. |

### Comms preferences (per-order)

| ISN field | v3 column | Notes |
|---|---|---|
| `sendemailevents` | `inspections.customFields.sendEmailEvents` | Preserve; default behavior is customer-level. |
| `sendsmsevents` | `inspections.customFields.sendSmsEvents` | Same. |
| `ignoresignaturefordelivery` | `inspections.customFields.ignoreSignatureForDelivery` | Override flags; rare use; preserved. |
| `ignoresignaturepaymentfordelivery` | same pattern | |
| `ignorespaymentfordelivery` | same pattern | |

### Big nested fields

| ISN field | v3 column | Notes |
|---|---|---|
| `controls[]` (137 items) | `inspections.customFields` (filtered) | See custom-fields classification below. |
| `costcenter`, `costcentername` | `inspections.customFields.territory` | Territory model thin (only "Territory A" observed); preserve as customFields hint until territories table goes live. |

### Custom fields classification (controls[] split)

ISN's `controls[]` mixes real custom data with embedded call-center scripts. The migration parser (`parse_isn_controls()`) splits:

**Migrate to `customFields` jsonb (real fields):**

- `Date Received`, `Complaint Managed By`, `Complaint Category 1..N`, `Complaint Legitimacy 1..N`, `Description of Issue 1..N`, `Refund Amount ($) / Category 1..N`
- `Add'l Services`, `Concerns`, `Outbuildings`, `Termite Inspections`, `Access`, `Client Attending`, `Payment` (notes), `Notes`
- `Date Received`, `Ordered by:`

**Filter out (call-center scripts, NOT migrated):**

- Any control whose name starts with `< YOU >` or `< THEM >` (call-script prompts).
- Any control whose name contains `**SPELL BACK PHONETICALLY**`, `**SPELL BACK FULL NAME PHONETICALLY**`, or similar all-caps directive.
- Separator rows like `---------------------`.
- Section headers like `Client Information`, `Escrow Fields`.

**Heuristic (`parse_isn_controls`):** classify by name pattern. Anything that looks like a script prompt is dropped with a count logged. The migration script outputs a CSV of dropped scripts at `migration/dropped-scripts.csv` for traceability.

## /order/fees

Embedded as `fees[]` on the order detail. Per Phase 2 pilot: every order has exactly 25 fee rows (the fixed fee menu); most are 0; populated rows are the actual line items.

| ISN field | v3 column on `inspection_services` | Notes |
|---|---|---|
| `id` | (used as lookup, not stored) | The fee `id` maps to a `services.isnSourceId`. Migration translates ISN fee id → v3 service id at insert time. |
| `name` | (informational) | Used to validate the lookup, not stored. |
| `amount` | `fee` | Coerce string → decimal. |
| `outsourceamount` | `inspection_services.notes` (when nonzero) | Preserved as a note like `"outsource: $100.00"` until outsource gets its own slice. |

**Filter:** rows with `amount=0 AND outsourceamount=0` are skipped. Only populated fees produce inspection_services rows.

## /order/history (audit log import)

Per inspection migrated, fetch `/order/history/{id}` and convert each event to one `audit_log` row.

| ISN history event field | v3 audit_log column | Notes |
|---|---|---|
| `uid` | `audit_log.userId` | Lookup via `users.isnSourceId`. Empty `uid` → null (system events). |
| `by` (display name) | (dropped at column level; available in `changes` payload) | |
| `when` | `audit_log.createdAt` | Parse with timezone; ISN events come back in `-07:00` (Pacific). |
| `changes` (dict) | `audit_log.changes` | Stored as-is in the jsonb payload, with one extra key: `metadata.context = 'isn_history_import'`. |
| (synthesized) | `audit_log.action` | First event of an inspection's history → `'create'`. Subsequent events → `'update'` unless changes contain a status-change signal (then `'reschedule'`, `'cancel'`, `'release'`). |
| (synthesized) | `audit_log.outcome` | Always `'success'` for historical events. |
| (synthesized) | `audit_log.entityType` | `'inspection'`. |
| (synthesized) | `audit_log.entityId` | The new v3 inspection id. |
| (synthesized) | `audit_log.businessId` | Safe House business id. |
| (synthesized) | `audit_log.accountId` | Safe House account id. |
| (synthesized) | `audit_log.sessionId`, `requestId` | Null for historical events. |
| (synthesized) | `audit_log.ipAddress`, `userAgent` | Null for historical events. |

**Reschedule history reconstruction:** when an event's `changes` contains both "Inspection Date" and "Inspection Time" keys, also insert a `reschedule_history` row. The previous date/time comes from the prior version of the inspection (look back through history); the new date/time is in the event's `changes`.

## Fields deliberately not migrated

The cut list. Each entry has a reason; future-Troy can override with a separate decision.

| ISN field | Where | Reason |
|---|---|---|
| `state` (UUID) | users, customers, properties | We use `stateabbreviation` directly. |
| `fax` | users, offices | Empty in sampled data. |
| `ipaccesskey`, `ipsecretkey` | users | Secrets do not live in schema columns (S6). |
| `manager`, `manageremail` | offices | Captured via `user_roles` instead. |
| `helpdeskid` | offices | Unused. |
| `latitude`, `longitude` | offices | Geo lives on properties. |
| `cancelreason`, `cancelreasonstring`, `canceledby`, `canceleddatetime` | order | All empty; cancellation goes through delete. |
| `canceled` (flag) | order | Unused at Safe House per platform issue #9. |
| `confirmedby` (when sourced from `/order/history`) | order | Use `inspections.confirmedBy` directly only if `/order` populates it; otherwise reconstruct via history import. |
| `inspector4` ... `inspector10` populated values + all `inspectorNrequested` flags | order | Slots 4-10 unused; multi-inspector via junction has no slot ceiling; requested flags not operationally used. |
| `escrowofficer`, `insuranceagent`, `policyholder`, `policynumber` | order | Safe House does not use escrow/insurance workflows. |
| `gatecode`, `majorcrossstreets` | order | Empty in sampled data. |
| `coupons`, `taxes`, `packages` | order | Unused features. |
| `buyersagentcontactnotes`, `sellersagentcontactnotes` | order | Empty; agent notes belong on `transaction_participants`. |
| `referredreason` | order | Empty; likely typo'd duplicate of `referreason`. |
| `mapurl` | order | Recomputed from lat/long. |
| `datetimeformatted` | order | Display string; recomputed. |
| `services[]` | order | Denormalized; `fees[]` is the source of truth. |
| `scheduleddatetime`, `scheduledby` (column) | order | Captured via audit_log import; not denormalized columns. |
| ISN `state` lookup table | (entire entity) | Replaced by `stateabbreviation` everywhere. |
| ISN `foundation` lookup table | (entire entity) | UUID translated to controlled vocabulary string at migration. |
| Call-center script controls (subset of `controls[]`) | order | Filtered by `parse_isn_controls`; logged to `migration/dropped-scripts.csv`. |
| ISN `/orders/footprints` results | (endpoint) | Transient; not a data source. |
| Test orders, voided orders, orders > N years old | (filter at migration) | Migration plan policy: cancellations > 6 months old archive to CSV (per directive); orders > 3 years old import for historical reporting; test/draft orders skipped. |

## v3 fields ISN does not have

| v3 column | Why added |
|---|---|
| `accounts.*` (entire table) | Licensing readiness. |
| `users.emailVerifiedAt` | Required for sensitive notification gating per S2. |
| `user_credentials.*`, `user_security.*`, `user_mfa_factors.*` | Credentials, login security, MFA split out per S6/S7/S10. |
| `user_roles.expiresAt`, `expirationReason` | Real-world need: vacation coverage, project-based access. |
| `customers.emailOptIn` | ISN does not separate email vs SMS opt-in. Default `true` on import. |
| `customer_businesses`, `property_businesses`, `agency_businesses`, `customer_properties` | Cross-business activity tracking (Pattern B). |
| `properties.bedrooms`, `bathrooms`, `propertyType` | Useful operational metadata; populated post-migration. |
| `inspections.billToParticipantId` | Bill-to-closing workflow. |
| `inspections.customFields` | Replaces ISN's `controls[]` after script filtering. |
| `services.defaultDurationMinutes` | ISN ordertypes have no duration; we add it. Default 180 min on migration. |
| `services.category` | Optional UI grouping. Null on migration. |
| `inspections.source`, `sourceParticipantId` | Booking provenance (dispatcher, realtor portal, client booking, etc.). |
| `inspector_*` (now `technician_*`) availability tables | ISN's loose ZIP/territory tracking replaced by explicit hours/time-off/zips. |
| `audit_log.sessionId`, `requestId`, `outcome`, `changesSize` | Forensic correlation and outcome tracking. |
| Soft-delete columns on 7 tables | Security spec S4. |
| `businesses.displayOrder`, `businesses.config` | UI affordance + per-business catch-all config. |

## Helper signatures

The migration plan and migration scripts use these helpers. Implementations land in `specs/migration/helpers/`.

```ts
// Parse any ISN datetime string to UTC. Handles unzoned ("2026-04-27 13:30:00",
// treated as Pacific) and ISO-with-offset ("2026-04-26T19:46:06+00:00").
function parseIsnDatetime(s: string | null | undefined): Date | null;

// Coerce ISN's stringly-typed booleans ("yes", "no", "true", "Yes", "No") to JS boolean.
function coerceIsnBoolean(s: string | boolean | null | undefined): boolean;

// Trim trailing/leading whitespace from ISN string fields. ISN inserts trailing
// whitespace inconsistently (city, manageremail, url all observed).
function normalizeIsnString(s: string | null | undefined): string | null;

// Translate ISN status flag combination to v3 inspection status enum.
function deriveStatusFromIsnOrder(o: ISNOrderDetail): InspectionStatus;

// Translate ISN paid flag plus payment events to v3 payment status.
function derivePaymentStatusFromIsn(o: ISNOrderDetail): PaymentStatus;

// Translate ISN signature flag plus agreement state to v3 signature status.
function deriveSignatureStatusFromIsn(o: ISNOrderDetail): SignatureStatus;

// Classify an ISN user record into target businesses + roles + status. Drives
// the user-audit step in the migration plan.
function classifyIsnUser(u: ISNUser): {
  importAs: 'active' | 'inactive' | 'skip';
  businesses: Array<{ businessId: string; roles: Role[] }>;
  reasoning: string;
};

// Classify an ISN contact (client / agent / escrowofficer / insuranceagent)
// into customer or transaction_participant or both.
function classifyIsnContact(c: ISNContact): {
  asCustomer?: { reasoning: string };
  asParticipant?: { primaryRole: RoleInTransaction; reasoning: string };
  skip?: { reasoning: string };
};

// Split ISN's controls[] into real custom fields (jsonb-bound) and embedded
// call-center scripts (dropped, logged to CSV).
function parseIsnControls(controls: ISNControl[]): {
  customFields: Record<string, unknown>;
  scriptsDropped: Array<{ name: string; reason: string }>;
};

// Property dedupe key. Lowercase + whitespace-normalized.
function propertyDedupeKey(p: { address1: string; city: string; state: string; zip: string }): string;

// Customer dedupe key. Lowercase + whitespace-normalized.
function customerDedupeKey(c: { email: string | null; displayName: string }): string;

// Foundation UUID lookup. ISN normalizes foundation type to a UUID; we use
// controlled vocabulary strings.
function translateIsnFoundation(uuid: string | null): string | null;
```

## Open questions

1. **ISN agency record deep crawl.** We did not pull `/agencies` directly in Phase 2. The agency_id on each agent record points at one. Migration script needs the agency record shape confirmed before locking. Action: pull a few agencies from the API during the migration-script implementation phase.

2. **/clients deep crawl.** Same as above for clients. Mapping above is inferred from the ISN spec and order detail's client reference. Confirm during implementation.

3. **ISN foundation lookup table contents.** We translate UUIDs to controlled-vocabulary strings, but the source values are unknown. Action: pull the foundation lookup once and bake the translation table into `translateIsnFoundation`. Could be 5 entries or 50.

4. **`scheduledby` and `scheduleddatetime` reconstruction priority.** These are ISN columns that we drop in favor of audit_log. If, during migration, the audit_log import does not yield the schedule event (because ISN history is incomplete for older orders), we lose schedule provenance. Recommendation: capture in the migration plan that for orders where history is sparse, populate `inspections.createdBy` from `scheduledby` as a fallback. Decide during migration script implementation.

5. **Outsource workflow preservation.** `osorder=yes` is set on every order in our pilot (15/15). Either Safe House outsources nearly everything, OR `osorder` means something other than "outsourced." Unknown. Recommendation: treat `osorder` as a customFields hint, do not interpret. Confirm with Troy during migration plan finalization.

6. **`utilitieson`, `propertyoccupied`, `salesprice`** placement. These could either live on `properties` (semantic argument: they describe the property) or on `inspections` (operational argument: they describe the property at the time of inspection, which can change). Today they go on `inspections.customFields`. Reconsider when those fields prove operationally important.
