# Migration Plan

_Status: LOCKED 2026-04-28. Companion to `specs/01-schema.ts` (v3.1.1), `specs/04-field-mapping.md`, and `specs/02-api-contract.yaml`._

This plan covers the full migration from ISN (Inspection Support Network) to the v3.1.1 schema. It assumes an empty target database with the v3.1.1 schema already applied (Option A, per Troy's directive 2026-04-27 16:56 UTC).

---

## Migration design principles

_Captured during spec 04 lock; documented in full in `01-schema-rationale.md`. Repeated here because they govern every step._

1. **Post-pass derivation over import-time guessing.** When a column's value can be derived from related data after import, derive in a second pass. `transaction_participants.primaryRole` is the canonical example: NULL on initial import, computed from `inspection_participants.role_in_transaction` distribution after orders are imported.

2. **Per-account config for terminology, not code branches.** Migration logic that depends on per-account operational vocabulary lives in a per-account config object passed to the script (`PerAccountConfig`). Examples: `accountRoleMapping`, `defaultDurationByBusinessType`. No conditional branches keyed on account identity.

Both principles apply to every step and every script in `specs/migration/`.

---

## Source decisions and findings

| Source | Key finding |
|---|---|
| `decisions/2026-04-26-design-decisions.md` D5 | User-audit step required; inspector count is input data, not a constraint. |
| `decisions/2026-04-26-multi-business-architecture.md` | User-to-business classification; contact split (customers vs participants). |
| `discovery/04-phase1-results.md` | 296 ISN users, 19 active inspectors, 8,934 agent stubs. |
| `discovery/06-phase2-block-a-findings.md` | /orders returns stubs, `after=` filter ignored, 37,032 open + 24,355 completed lifetime orders. |
| `discovery/07-phase2-pilot-findings.md` | 97 fields per order, 30% dead surface, `controls[]` mixes data + scripts, no duration field on ordertypes. |
| `discovery/08-phase2-augment-history-findings.md` | ISN cancel = soft-delete (`deleteddatetime`), history endpoint rich (42 tracked fields), ISN server clock is Pacific. |
| `specs/04-field-mapping.md` | Full ISN→v3 field mapping, helper signatures, cut list, per-type duration defaults. |

---

## Required helpers

All helpers live in `specs/migration/helpers/`. TypeScript, strict mode, Drizzle + Neon Postgres patterns.

| Helper | Signature | Notes |
|---|---|---|
| `parseIsnDatetime` | `(s: string \| null \| undefined): Date \| null` | Handles `"2026-04-27 13:30:00"` (no tz, treat as Pacific) and `"2026-04-26T19:46:06+00:00"` (UTC offset). Always returns UTC. |
| `coerceIsnBoolean` | `(s: string \| boolean \| null \| undefined): boolean` | Coerces `"yes"`, `"no"`, `"Yes"`, `"No"`, `"true"`, `"false"` to boolean. |
| `normalizeIsnString` | `(s: string \| null \| undefined): string \| null` | Trims leading/trailing whitespace. ISN has inconsistent trailing whitespace on city, manageremail, url, etc. |
| `deriveStatusFromIsnOrder` | `(order: ISNOrderDetail): InspectionStatus` | Checks `deleteddatetime` first → `'cancelled'`; then `complete='yes'` → `'completed'`; then `confirmeddatetime` → `'confirmed'`; else → `'scheduled'`. |
| `derivePaymentStatusFromIsn` | `(order: ISNOrderDetail): PaymentStatus` | `paid='yes'` → `'paid'`; `paid='no'` → `'unpaid'`. Partial/refunded/disputed not represented in ISN; v3 expands. |
| `deriveSignatureStatusFromIsn` | `(order: ISNOrderDetail): SignatureStatus` | `signature='yes'` → `'signed'`; `signature='no'` → `'unsigned'`. |
| `deriveSourceFromIsnOrder` | `(order: ISNOrderDetail): BookingSource` | `osorder='yes'` → `'realtor_portal'`; `osorder='no'` → `'dispatcher'`. Account-agnostic per spec 04. |
| `defaultDurationForBusinessType` | `(type: BusinessType): number` | Returns: `inspection`=180, `pool`=60, `pest`=45, `other`=60. Reads `businesses.config.schedulingDefaults.defaultDurationMinutes` first. |
| `classifyIsnUser` | `(user: ISNUser, config: PerAccountConfig): UserClassification` | Output: target businesses + roles + status + reasoning. Per D5 user-audit step. |
| `classifyIsnContact` | `(contact: ISNContact, config: PerAccountConfig): ContactClassification` | Output: `asCustomer?`, `asParticipant?`, `skip?` with reasoning. |
| `parseIsnControls` | `(controls: ISNControl[]): { customFields: Record<string, unknown>; scriptsDropped: Array<{name: string; reason: string}> }` | Splits real custom fields from embedded call-center scripts. Scripts logged to `migration/dropped-scripts.csv`. |
| `propertyDedupeKey` | `(p: {address1: string; city: string; state: string; zip: string}): string` | Lowercase + whitespace-normalized. Used for deduplication. |
| `customerDedupeKey` | `(c: {email: string \| null; displayName: string}): string` | Lowercase + whitespace-normalized. |
| `translateIsnFoundation` | `(uuid: string \| null): string \| null` | Translates ISN's foundation UUID to a controlled vocabulary string. Translation table built from a one-time ISN API call during migration prep. |
| `recomputeGroupSensitivity` | `(groupKey: string, db: DrizzleDb): Promise<boolean>` | Runtime DB version of the seed-time helper. Called after any `permission_group_members` mutation. |

---

## Step 0: Seed system-managed reference data and seed account

Runs as an idempotent Drizzle migration. Safe to re-run on every deploy.

### 0.1 Permissions catalog

Insert all 50 granular permissions from `PERMISSIONS_SEED` in `specs/shared/schemas/permissions-seed.ts`.
Pattern: `INSERT INTO permissions ... ON CONFLICT (key) DO NOTHING`.

### 0.2 Permission groups

Insert 9 groups from `PERMISSION_GROUPS_SEED`. Same idempotency pattern.

### 0.3 Group memberships

Insert 62 group↔permission rows from `GROUP_MEMBERS_SEED`. Pattern: `ON CONFLICT (group_key, permission_key) DO NOTHING`.

After insert, call `recomputeGroupSensitivity(groupKey, db)` for all 9 groups to verify cached `sensitive` flags match contained permissions. Fails fast with a clear error if cache is stale; this is a migration-time invariant.

### 0.4 Seed account

```sql
INSERT INTO accounts (id, name, slug, status, plan_tier, config, created_by, last_modified_by)
VALUES (
  gen_random_uuid(),
  'Pappas Group',                       -- or final operational name
  'pappas',                             -- globally unique slug
  'active',
  'internal',
  jsonb_build_object(
    'security',    jsonb_build_object('requireMfaForOwners', true),
    'audit_retention_days', 2555        -- 7 years
  ),
  NULL,                                 -- chicken-and-egg; system user created next
  NULL
)
ON CONFLICT (slug) DO NOTHING;
```

### 0.5 System user

```sql
INSERT INTO users (id, account_id, email, display_name, status, is_system, password_hash)
VALUES (
  gen_random_uuid(),
  (SELECT id FROM accounts WHERE slug = 'pappas'),
  'system@pappas.local',
  'System (seed)',
  'active',
  TRUE,
  NULL
)
ON CONFLICT (account_id, email) DO NOTHING;
```

Then update `accounts.created_by` and `accounts.last_modified_by` to the system user's id.

### 0.6 Seed businesses

Insert three businesses for the seed account, with `created_by` and `last_modified_by` = system user id:

| name | slug | type | displayOrder |
|---|---|---|---|
| Safe House Property Inspections | safehouse | inspection | 1 |
| HCJ Pool Services | hcj-pools | pool | 2 |
| Pest Heroes | pest-heroes | pest | 3 |

Pattern: `ON CONFLICT (account_id, slug) DO NOTHING`.

### 0.7 Order-number sequences

```sql
CREATE SEQUENCE IF NOT EXISTS order_number_seq_safehouse START 1;
CREATE SEQUENCE IF NOT EXISTS order_number_seq_hcj_pools START 1;
CREATE SEQUENCE IF NOT EXISTS order_number_seq_pest_heroes START 1;
```

### 0.8 Default role permissions

Insert rows from `DEFAULT_ROLE_PERMISSIONS_SEED` for the seed account (account_id = 'pappas' account). Pattern: `ON CONFLICT (account_id, role, permission_key, group_key) DO NOTHING`.

### 0.9 Seed audit log entry

```sql
INSERT INTO audit_log (id, account_id, business_id, user_id, action, outcome, entity_type, changes)
VALUES (
  gen_random_uuid(),
  (SELECT id FROM accounts WHERE slug = 'pappas'),
  NULL,
  (SELECT id FROM users WHERE email = 'system@pappas.local'),
  'create',
  'success',
  'system',
  jsonb_build_object(
    'metadata', jsonb_build_object(
      'context', 'system_seed',
      'migration_id', '<migration_file_id>'
    )
  )
);
```

---

## Step 1: User audit and import

### 1.1 Pull ISN users

Call `GET /users` (ISN API). 296 records in Phase 1 sample; actual count may vary.

### 1.2 Classify each user

Run `classifyIsnUser(user, config)` per user. Output schema:

```ts
type UserClassification = {
  isnUserId: string;
  isnUsername: string;
  importAs: 'active' | 'inactive' | 'skip';
  businesses: Array<{ businessSlug: string; roles: Role[] }>;
  reasoning: string;
};
```

Default classification rules:

| ISN flags | Classification |
|---|---|
| `inspector=Yes, show=Yes` | `active`, `businesses=[{safehouse, roles:[technician]}]` |
| `owner=Yes, show=Yes` | `active`, `businesses=[{safehouse,hcj-pools,pest-heroes}, roles:[owner]]` |
| `manager=Yes, show=Yes` | `active`, `businesses=[{safehouse}, roles:[operations_manager]]` |
| `officestaff=Yes, show=Yes` | `active`, `businesses=[{safehouse}, roles:[dispatcher]]` — default; `accountRoleMapping` can override |
| `callcenter=Yes, show=Yes` | `active`, `businesses=[{safehouse}, roles:[client_success]]` — default; `accountRoleMapping` can override |
| `thirdparty=Yes, show=Yes` | `active`, `businesses=[{safehouse}, roles:[viewer]]` |
| Any flag, `show=No` | Manual review; default `inactive` |
| All flags `No` | `skip` |

Multi-flag users (e.g., `inspector=Yes, owner=Yes`) get multiple roles.

Output written to `migration/user-classification.csv` (gitignored, contains PII).
Review before running import.

### 1.3 Import users

For each user with `importAs != 'skip'`:

1. Insert `users` row.
2. For each classified business+role combo, insert `user_businesses` and `user_roles` rows.
3. Apply `ROLE_IMPLICIT_DENIES` for each granted role as `user_permission_overrides` rows.
4. Preserve `isnSourceId` on the users row for back-reference.

Also insert into `user_credentials` a row with `kind='password'`, `secret=NULL` (no password; user must reset on first login), `requireRotation=TRUE`.

---

## Step 2: Contact split and import

### 2.1 Pull ISN clients

Call `GET /clients`. Deep-crawl each record via `GET /client/{id}` (Phase 2 did not fully crawl clients; this is a migration-prep step).

### 2.2 Pull ISN agents, escrow officers, insurance agents

Call `GET /agents`, `GET /escrowofficers`, `GET /insuranceagents`. Pull full records per stub via detail endpoints.

### 2.3 Classify each contact

Run `classifyIsnContact(contact, config)`. Rules:

- ISN clients → `customers` (most cases) + `customer_businesses[safehouse]` junction.
- ISN agents → `transaction_participants` with `primaryRole=null` (to be derived post-pass).
- ISN escrow officers → `transaction_participants` with `primaryRole='escrow_officer'`.
- ISN insurance agents → `transaction_participants` with `primaryRole='insurance_agent'`.
- Agencies (derived from agent records) → `agencies` + `agency_businesses[safehouse]`.

Dedup: apply `customerDedupeKey` for client records; merge duplicates and log to `migration/contact-dedup.csv`.

### 2.4 Import contacts

Insert in dependency order:
1. `agencies` (referenced by `transaction_participants.agencyId`)
2. `customers`
3. `transaction_participants`
4. `customer_businesses` junctions
5. `agency_businesses` junctions

---

## Step 3: Property import

### 3.1 Extract properties from ISN orders

ISN orders carry property fields inline. Extract unique properties by applying `propertyDedupeKey` across all order records. Merge duplicates, keeping the most-complete record.

### 3.2 Import properties

Insert `properties` rows. For each, also insert `property_businesses[safehouse]` junction.

**Dedup rule:** strict match on lowercased, whitespace-normalized `(address1, city, state, zip)` within the account. Log merge decisions to `migration/property-dedup.csv`.

---

## Step 4: Order migration (inspections)

### 4.1 Order class filter

Apply the following filter to all 61,387 ISN lifetime orders (stubs + detail):

| Order class | ISN signals | Action |
|---|---|---|
| Active (scheduled, open) | `show=yes`, `complete=no`, `deleteddatetime=null` | Import to v3 inspections |
| Completed | `show=yes`, `complete=yes`, `deleteddatetime=null` | Import, any age |
| Cancelled within last 6 months | `deleteddatetime` within 6 months of migration date | Import with `status='cancelled'` |
| Cancelled older than 6 months | `deleteddatetime` older than 6 months | Export to `migration/archived-cancellations.csv`, then skip |
| Test/placeholder | `totalfee=0 AND squarefeet=0 AND no customer` (heuristic; refine during migration prep) | Skip |

The 6-month cutoff is applied from the migration run date, not from the order's scheduled date.

`archived-cancellations.csv` schema (PII-containing, stays in gitignored `migration/`):

```
isn_order_id, order_number, deleted_at, deleted_by_isn_uid, scheduled_at, customer_isn_id, property_address, property_zip, fee_amount, ordertype_name, inspector1_isn_uid
```

### 4.2 Pull order detail

For each qualifying order (stub from `/orders`), call `GET /order/{id}?withallcontrols=true&withpropertyphoto=false`.

**Throttle:** 400ms between calls. ISN API is fragile; respect it.

### 4.3 Map fields

Per `specs/04-field-mapping.md`. Key mappings to confirm at migration-prep time:

- `id` → `inspections.isnSourceId`
- `oid` → `inspections.isnReportNumber` (ISN's serial number; we generate fresh `orderNumber` via sequence)
- `datetime` → `inspections.scheduledAt` (via `parseIsnDatetime`, treat unzoned as Pacific)
- `duration` → `inspections.durationMinutes`
- `inspector1` → `inspections.leadInspectorId` (lookup via `users.isnSourceId`)
- `inspector2`/`inspector3` → `inspection_inspectors` junction rows
- `client` → `inspections.customerId` (lookup via `customers.isnSourceId`)
- property fields → `inspections.propertyId` (lookup via `propertyDedupeKey`)
- `buyersagent` → `inspection_participants` with `role_in_transaction='buyer_agent'`
- `sellersagent` → `inspection_participants` with `role_in_transaction='listing_agent'`
- `ordertype` → `inspections.services` (lookup service by `isnSourceId`; add `inspection_services` row)
- `fees[]` (nonzero) → `inspection_services` rows
- `totalfee` → `inspections.feeAmount`
- `osorder='yes'` + `osscheduleddatetime` → `inspections.source='realtor_portal'`, `inspections.customFields.onlineScheduledAt`
- `controls[]` → `parseIsnControls()` → `inspections.customFields`
- `costcenter` / `costcentername` → `inspections.customFields.territory` (until territories table is built)
- `deleteddatetime` → `inspections.cancelledAt` (per platform issue #9)
- `deletedby` → `inspections.cancelledBy`

### 4.4 Status derivation

```ts
inspections.status = deriveStatusFromIsnOrder(order);
inspections.paymentStatus = derivePaymentStatusFromIsn(order);
inspections.signatureStatus = deriveSignatureStatusFromIsn(order);
inspections.source = deriveSourceFromIsnOrder(order);
```

For `on_hold` orders (no `datetime` or `datetime` clearly stale, `complete=no`, `deleteddatetime=null`): set `scheduledAt = ON_HOLD_PLACEHOLDER_AT` per the schema convention.

### 4.5 Generate order numbers

For each imported inspection:

```sql
SELECT nextval('order_number_seq_safehouse');
-- Format: SH-{year(isnOrder.datetime)}-{seq:06d}
```

Year is derived from the ISN order's `datetime` field, not the migration run date.

---

## Step 5: Audit history import

For every imported inspection (not skipped), call `GET /order/history/{id}` on the ISN API.

Parse events per `discovery/08-phase2-augment-history-findings.md`:

```ts
for (const event of history) {
  await db.insert(auditLog).values({
    accountId: seedAccountId,
    businessId: safeHouseBusinessId,
    userId: lookupUserByIsnUid(event.uid) ?? systemUserId,
    action: event === firstEvent ? 'create' : 'update',
    outcome: 'success',
    entityType: 'inspection',
    entityId: v3InspectionId,
    changes: {
      ...event.changes,
      metadata: { context: 'isn_history_import', isnEventTimestamp: event.when }
    },
    createdAt: parseIsnDatetime(event.when),
    requestId: null,
    sessionId: null,
  });
}
```

**Reschedule detection:** if event.changes contains both "Inspection Date" and "Inspection Time", also insert a `reschedule_history` row (Step 6).

---

## Step 6: Reschedule history reconstruction

From the audit history events (Step 5), detect reschedule patterns:

- Event has "Inspection Date" and/or "Inspection Time" in `changes`, and is NOT the create event.
- Insert `reschedule_history` row with `previousScheduledAt` (look back to prior event's value) and `newScheduledAt` (this event's value).
- `reason = null` (ISN does not capture reschedule reasons in history).
- `initiatedBy = lookupUserByIsnUid(event.uid)`.

---

## Step 7: Post-pass derivations

### 7.1 transaction_participants.primaryRole

For each imported `transaction_participants` row from ISN agents (non-escrow, non-insurance): count `inspection_participants.role_in_transaction` values linked to this participant. Set `primaryRole` to the most frequent. Ties resolve to `buyer_agent`.

Log to `migration/participant-role-derivation.csv` for audit.

### 7.2 customer_businesses.lastActivityAt

For each `customer_businesses` row, compute `lastActivityAt` from the most recent `inspections.completedAt` or `inspections.scheduledAt` (whichever is later) for inspections where `customerId` matches. Update in bulk.

### 7.3 property_businesses.lastActivityAt

Same pattern for properties.

---

## Step 8: Permission overrides for known day-one exceptions

After Step 1 user import, apply known first-day permission overrides:

- Day-one overrides are determined by the user audit (Step 1 classification output).
- Each override is an `INSERT INTO user_permission_overrides` row with `effect='grant'` or `effect='deny'`, `reason`, `grantedBy=systemUserId`, `grantedAt=now()`.
- Common cases: inspector needing `view.customer.pii` explicitly; bookkeeper needing `view.audit_log` for reconciliation.

---

## Sequencing summary

| Step | What | Dependencies |
|---|---|---|
| 0 | Seed reference data + account scaffolding | Empty DB with v3.1.1 schema |
| 1 | User audit + import | Step 0 |
| 2 | Contact split + import (agencies, customers, participants) | Step 0, Step 1 (for `created_by` FKs) |
| 3 | Property import | Step 0, Step 1 |
| 4 | Order migration (inspections, line items, participants) | Steps 1, 2, 3 |
| 5 | Audit history import | Step 4 |
| 6 | Reschedule history reconstruction | Step 5 |
| 7 | Post-pass derivations (primaryRole, lastActivityAt) | Steps 4, 5 |
| 8 | Day-one permission overrides | Step 1 |
| Validation | Full validation pass | All steps complete |

---

## Idempotency

Every migration step is designed to be **safe to re-run any number of times without duplicates or data corruption.** If a step fails halfway, re-run from the failing step. No manual cleanup required.

### Upsert pattern for all entity imports (Steps 1-4)

For every entity import (`users`, `customers`, `transaction_participants`, `agencies`, `properties`, `inspections`), the script:

1. Looks up any existing row by `isnSourceId` within the account:
   ```ts
   const existing = await db.query.inspections.findFirst({
     where: and(
       eq(inspections.businessId, safeHouseBusinessId),
       eq(inspections.isnSourceId, isnOrder.id)
     )
   });
   ```
2. If found: compute a patch (fields that actually changed). If the patch is non-empty, update and write an `audit_log` entry with `action='update'`, `changes={before, after}`. If patch is empty, skip (already current).
3. If not found: insert and write an `audit_log` entry with `action='create'`.

This means running the migration twice on the same data is identical to running it once. Updated fields converge; unchanged fields are skipped.

### Audit log writes (Step 5)

Each ISN history event maps to one `audit_log` row. Dedup key: `sha256(isn_order_id + '|' + event.when)`, stored as `audit_log.requestId`. Insert with:

```sql
INSERT INTO audit_log (..., request_id) VALUES (..., :dedup_key)
ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING;
```

This requires the `audit_log.requestId` to be unique-where-not-null. It already is via the `byRequest` partial index on `request_id IS NOT NULL`.

### Reschedule history (Step 6)

Natural dedup key: `(inspection_id, previous_scheduled_at, new_scheduled_at)`. Migration inserts with:

```sql
INSERT INTO reschedule_history (...)
ON CONFLICT (inspection_id, previous_scheduled_at, new_scheduled_at) DO NOTHING;
```

This requires a unique index on that composite. If migration prep reveals collisions (rare: two reschedules to the same timestamps), fall back to Option A: add an `isn_source_key varchar(255)` column to `reschedule_history` (schema v3.1.2 additive change). Flag the issue and decide during migration prep.

### Post-pass derivations (Step 7)

UPDATE statements, inherently idempotent. Running twice sets the same derived value both times.

### Permission overrides (Step 8)

```sql
INSERT INTO user_permission_overrides (...)
ON CONFLICT (user_id, business_id, permission_key, group_key, effect) DO NOTHING;
```

Already idempotent via the composite PK.

### Re-run behavior summary

| What happens if you re-run a step | Effect |
|---|---|
| Entity already exists with same data | No-op (patch is empty) |
| Entity already exists with updated data from ISN | Update applied, audit_log entry written |
| Entity does not exist | Insert + audit_log entry |
| Audit log event already imported | Skipped (ON CONFLICT DO NOTHING on requestId) |
| Reschedule history row already exists | Skipped (ON CONFLICT DO NOTHING on natural key) |
| Permission override already exists | Skipped (ON CONFLICT DO NOTHING on composite PK) |

No manual cleanup, no table truncation, no re-sequencing required.

---

## Cancellation archive policy

Cancellations older than 6 months (from migration run date) are NOT imported into v3. They are exported to `migration/archived-cancellations.csv` before being skipped.

This CSV is:
- Gitignored (PII).
- Retained indefinitely as the historical record of cancelled inspections.
- Available for lookup if a customer asks about an old cancelled booking.

Policy locked: Troy's directive 2026-04-26 23:17 UTC.

---

## Required cut list

Fields not migrated from ISN. Per `specs/04-field-mapping.md`:

| ISN field | Where | Reason |
|---|---|---|
| `canceled` flag | order | Vestigial; cancellation = `deleteddatetime` (platform issue #9) |
| `cancelreason`, `cancelreasonstring`, `canceledby`, `canceleddatetime` | order | All empty in sampled data; ISN cancels via delete |
| `escrowofficer`, `policyholder`, `policynumber`, `insuranceagent` | order | Safe House does not use these workflows |
| `gatecode`, `majorcrossstreets` | order | Empty in sampled data |
| `coupons`, `taxes`, `packages` | order | Unused ISN features |
| `inspector4`–`inspector10` slots | order | Slots 4-10 unused; multi-inspector via junction has no ceiling |
| `buyersagentcontactnotes`, `sellersagentcontactnotes` | order | Empty; agent notes belong on `transaction_participants.notes` |
| `referredreason` | order | Empty; likely typo'd duplicate of `referreason` |
| `datetimeformatted` | order | Display string; recomputed in v3 from `scheduledAt` |
| `mapurl` | order | Recomputed from lat/long |
| `state` (UUID) | user, order | We use `stateabbreviation` directly |
| `foundation` UUID | order | Translated to controlled vocab string via `translateIsnFoundation()` |
| `ipaccesskey`, `ipsecretkey` | user | Secrets not stored in schema columns (S6) |
| `fax` | user | Empty in sampled data |
| Call-center script controls | order `controls[]` | Filtered by `parseIsnControls()`; logged to `migration/dropped-scripts.csv` |

---

## Required preserves (renamed)

| ISN field | v3 column | Notes |
|---|---|---|
| `deleteddatetime` | `inspections.cancelledAt` | Per platform issue #9 |
| `deletedby` | `inspections.cancelledBy` | Per platform issue #9 |
| `confirmeddatetime` | `inspections.confirmedAt` | Phase 2 pilot |
| `initialcompleteddatetime` | `inspections.initialCompletedAt` | Phase 2 pilot |
| `controls[]` (filtered) | `inspections.customFields` | After `parseIsnControls()` filter |
| `osorder` + `osscheduleddatetime` | `inspections.source` + `inspections.customFields.onlineScheduledAt` | Spec 04 lock |
| `costcenter` / `costcentername` | `inspections.customFields.territory` | Thin territory model; territories table deferred |

---

## Validation checklist

Run after all migration steps complete. Failures block cutover.

### Row count checks
- [ ] `users` count = ISN active users post-audit minus skipped
- [ ] `customers` count = ISN client count minus dedup merges minus skipped
- [ ] `transaction_participants` count = ISN agent + escrow + insurance count minus dedup
- [ ] `agencies` count = distinct agency UUIDs across all ISN agent records
- [ ] `inspections` count (active+completed) = ISN count for matching window
- [ ] `inspections` count (cancelled) = ISN deleted-orders count for last 6 months
- [ ] `archived-cancellations.csv` row count = ISN deleted-orders older than 6 months
- [ ] `inspection_participants` rows = expected agent↔inspection linkages from ISN `buyersagent`/`sellersagent` fields
- [ ] `reschedule_history` row count > 0 (if ISN history events include reschedule patterns)

### Integrity checks
- [ ] No orphaned FKs: all `inspections.customerId` values reference existing `customers.id`
- [ ] No orphaned FKs: all `inspections.propertyId` values reference existing `properties.id`
- [ ] No orphaned FKs: all `inspections.leadInspectorId` values reference existing `users.id`
- [ ] All `user_roles` reference valid `businesses.id` and `users.id` in the same account
- [ ] `audit_log.accountId` matches the entity's account for a random 100-row sample (INV-1 check)
- [ ] No `users` row with `is_system=TRUE` has a `password_hash` (system user must have null creds)

### Spot-check inspection round-trips
- [ ] Pick 10 ISN orders (2 active, 2 completed, 2 cancelled-in-system, 2 aged, 2 with multiple inspectors)
- [ ] For each: fetch raw ISN detail from `discovery/raw/phase2/`, compare all migrated fields against v3 row
- [ ] Verify `scheduledAt` is UTC (not Pacific-offset)
- [ ] Verify `status` derived correctly from ISN flags
- [ ] Verify `feeAmount` equals sum of non-zero `fees[]` items
- [ ] Verify `customFields` contains expected real fields, no call-center scripts

### Permission checks
- [ ] For Troy's user: effective permissions = all (owner role in all three businesses)
- [ ] For a sample inspector: effective permissions include `operational` group, NOT `admin`
- [ ] For a sample bookkeeper: effective permissions include `financial`, NOT `view.customer.pii`
- [ ] No user has `is_system=TRUE` except the system user

### Cancellation archive
- [ ] `migration/archived-cancellations.csv` exists and contains all pre-6-month deleted orders
- [ ] No archived cancellation appears in the `inspections` table

---

## Open questions (carry forward to migration script implementation)

1. **Test/placeholder order detection heuristics.** The `totalfee=0 AND squarefeet=0 AND no customer` heuristic is approximate. Confirm or refine when reviewing the long tail of ISN orders during migration prep.

2. **InspectorLab event preservation.** Phase 2 augment showed "InspectorLab Triggered" events in ISN order history. Not migrated. If Safe House needs this data, it stays in `discovery/raw/phase2/` and must be handled separately.

3. **Translation table for `translateIsnFoundation()`.** The ISN foundation UUID lookup table contents are unknown (open question #3 from spec 04). Must pull from ISN API during migration prep and bake the translation map into the helper before running.

4. **Schedule provenance fallback.** For orders where ISN history is sparse (older orders, minimal event log), the schedule provenance event may not exist. Fallback: populate `inspections.createdBy` from `scheduledby` ISN field. Decide during migration script implementation.

5. **ISN `/clients` deep crawl.** Phase 2 did not pull full client records (only order-embedded references). Migration script must crawl `/clients` for complete customer data.

6. **ISN `/agencies` deep crawl.** Same as clients — agency records must be pulled from `/agencies` endpoint. Shape from the API to confirm during migration prep.
