# Migration Plan (Draft)

_Status: DRAFT, scaffolding only. Will be filled out fully after the schema is locked. Captured here so commitments made during discovery do not get lost._

## Migration design principles

_Captured 2026-04-27 during spec 04 lock; documented in full in `01-schema-rationale.md`. Repeated here because they govern this entire migration plan._

1. **Post-pass derivation over import-time guessing.** When a column's value can be derived from related data after import, derive in a second pass rather than guessing at import time. Spec 04 example: `transaction_participants.primaryRole` is NULL on initial import; a post-pass counts each participant's `inspection_participants.role_in_transaction` distribution and sets the most frequent value. Reduces wrong defaults that mislead until manually corrected.

2. **Per-account config for terminology, not code branches.** Migration logic that depends on per-account operational vocabulary (role flag meanings, custom field names, lookup table values, business-specific defaults) lives in a per-account config object passed to the migration script. NOT in conditional branches keyed on account identity. Spec 04 example: `accountRoleMapping` config overrides default ISN role flag mappings without requiring code changes for new licensees.

Both principles apply to every step in this plan and every script in `specs/migration/`. New steps that introduce account-sensitive logic must respect these principles.

## Source decisions and findings

- `decisions/2026-04-26-design-decisions.md` D5: user-audit step required.
- `decisions/2026-04-26-multi-business-architecture.md`: user-to-business and contact-split classification required.
- `discovery/04-phase1-results.md`: 296 ISN users, 19 active inspectors, 8,934 agent stubs.
- `discovery/07-phase2-pilot-findings.md`: 30% of ISN order surface dead, custom fields strategy, etc.
- `discovery/08-phase2-augment-history-findings.md`: cancellation = soft-delete, history is rich, time zones need handling.

## Required helpers (named, to be implemented)

| Helper | Purpose | Notes |
|---|---|---|
| `parse_isn_datetime(s: string): Date (UTC)` | Convert ISN datetime strings to UTC | Handle both `"2026-04-27 13:30:00"` (no tz, assume Pacific per ISN's `client` clock from Phase 0) and `"2026-04-26T19:46:06+00:00"` (UTC offset). Always returns timezone-aware UTC. |
| `derive_status_from_isn_order(order): InspectionStatus` | Map ISN's flag combo to v2 status enum | Checks `deleteddatetime` first (overloaded delete-as-cancel pattern, platform issue #9), then `complete`, `confirmeddatetime`, `scheduleddatetime`. Tested against pilot+augment data before being trusted. |
| `derive_payment_status_from_isn(order): PaymentStatus` | Map `paid` flag plus payment events to v2 paymentStatus | TBD detail. |
| `derive_signature_status_from_isn(order): SignatureStatus` | Map `signature` flag plus agreement state to v2 signatureStatus | TBD detail. |
| `classify_isn_user(user): UserClassification` | Decide active inspector / staff / dormant per user | Inputs from D5 audit step. Output: target businesses + roles + status. |
| `classify_isn_contact(contact): ContactClassification` | Decide customer vs transaction_participant | Per multi-business architecture decision. |
| `parse_isn_controls(controls): { customFields, scripts }` | Split genuine custom fields from embedded call-center scripts | Scripts are filtered out (not migrated, scoped to future office workflow module). Custom fields go to `inspections.customFields` jsonb. |

## Required classification steps

### Step 1: User audit (D5)

Audit all 296 ISN users from `/users`. Per user, decide:

- Target businesses (Safe House / HCJ / Pest Heroes / multiple).
- Target role(s) per business.
- Import as active, import as inactive, or skip.
- Reasoning, recorded inline in the audit output.

Output: `migration/user-classification.csv` (gitignored, contains PII).

### Step 2: Contact split (multi-business architecture)

Audit ISN's clients, agents, escrow officers, insurance agents. Per record, decide:

- `customers` (paying / receiving service).
- `transaction_participants` (realtors, TC, etc.).
- Both, with appropriate routing and inspection_participants linkage.
- Skip (test, duplicate, etc.).

Output: `migration/contact-classification.csv` (gitignored).

### Step 3: Order migration with cancellation cutoff

Per the platform-issue-#9 finding, ISN's "deleted" orders are cancellations. Migration policy:

- **Active and recent cancelled orders (last 3 years):** import to `inspections` with `status='cancelled'` for the deleted ones.
- **Cancellations older than 6 months:** export to **`projects/isn-replacement/migration/archived-cancellations.csv`** before skipping. Preserves historical record outside the new system.
- **Cancellations older than 3 years:** skip without CSV export, the archive file already covers 6-month+ history.

> Wait, that overlaps. Resolving: a single archive policy is cleaner.

**Policy as locked tonight:**

| Order class | Action |
|---|---|
| Active or completed within last 3 years | Import to v2 `inspections` |
| Cancelled within last 6 months | Import to v2 `inspections` with `status='cancelled'` |
| Cancelled older than 6 months | Export to `migration/archived-cancellations.csv`, then skip |
| Active or completed older than 3 years | Import to v2 `inspections` for historical reporting |
| Test / placeholder / draft (heuristics TBD) | Skip, no archive |

The 6-month cancellation cutoff comes from Troy's directive 2026-04-26 23:17 UTC: preserve the historical cancel record in CSV, do not pollute the operational v2 with old cancellations.

`archived-cancellations.csv` schema:

```
isn_order_id, order_number, deleted_at, deleted_by_name, scheduled_at, customer_name, customer_email, property_address, fee_amount, ordertype_name, inspector_name, cancellation_inferred_reason
```

The CSV stays under `migration/` which is gitignored (PII).

### Step 4: Custom fields and call-center script split

For each migrated inspection, parse `controls[]`:

- **Real custom fields** (e.g., "Date Received", "Refund Amount", "Complaint Category 1"): write to `inspections.customFields` jsonb keyed by sanitized field name.
- **Embedded call-center scripts** (e.g., "**SPELL BACK PHONETICALLY**", "< YOU > Ok, and let me go ahead..."): filter out. NOT migrated.

Heuristic for classification:

- Field name starting with `< YOU >`, `< THEM >`, `**`, or containing the strings `phonetically`, `spell back`, `say to client`: script.
- Field name matching a known dispatcher template prompt list: script.
- Otherwise: real field.

Output: classified custom field list reviewed before migration locks. Stored at `migration/custom-field-classification.csv`.

### Step 5: Audit history import

For every imported inspection, call `GET /order/history/{id}` and parse events. Each event becomes one row in v2 `audit_log`:

- `entityType = 'inspection'`
- `entityId = <new v2 inspection id>`
- `userId = users.lookup_by_isn_uid(event.uid) or system_user_id`
- `action = 'update'` (or `'create'` for the first event)
- `changes = event.changes` (jsonb)
- `createdAt = parse_isn_datetime(event.when)`

Cost: one extra API call per migrated inspection. Worth it for day-one audit trail.

### Step 6: Reschedule history reconstruction

Walk each inspection's audit history. When an event's `changes` contains both "Inspection Date" and "Inspection Time" (and the inspection already exists, i.e., not the create event), insert a row into `reschedule_history`:

- `previousScheduledAt`: the value before this event (look back through history)
- `newScheduledAt`: the value in this event's `changes`
- `previousInspectorId` / `newInspectorId`: similar lookup if "Inspector #1" changed
- `reason`: null (ISN does not record one)
- `initiatedBy`: from event.uid

## Required cut list

From Phase 2 pilot's "30% dead surface" finding plus augment's clarification on cancellation:

| ISN field | Action | Reason |
|---|---|---|
| `canceled` (boolean flag) | Cut | Vestigial; cancellation is `deleteddatetime` |
| `cancelreason`, `cancelreasonstring`, `canceledby`, `canceleddatetime` | Cut | Empty everywhere; cancellation goes through delete |
| `escrowofficer`, `policyholder`, `policynumber`, `insuranceagent` | Cut | Safe House does not use these workflows |
| `gatecode`, `majorcrossstreets` | Cut for now | Optional; reintroduce if data shows usage |
| `coupons`, `taxes`, `packages` | Cut | Unused features |
| `inspector4` through `inspector10` | Cut | Multi-inspector via junction, no slot ceiling |
| `buyersagentcontactnotes`, `sellersagentcontactnotes` | Cut | Empty everywhere; agent notes belong on transaction_participants |
| `referredreason` | Cut | Possibly typo'd duplicate of `referreason` |
| `confirmedby` | Cut | Confirmation tracked via `confirmedAt` only |
| `address2` (when empty) | Conditional | Migrate when populated; null when empty |

## Required preserves (renamed)

| ISN field | v2 column | Notes |
|---|---|---|
| `deleteddatetime` | `inspections.cancelledAt` | Per platform issue #9 |
| `deletedby` | `inspections.cancelledBy` | Per platform issue #9 |
| `confirmeddatetime` | `inspections.confirmedAt` | Phase 2 pilot decision |
| `initialcompleteddatetime` | `inspections.initialCompletedAt` | Phase 2 pilot decision |
| `costcenter` | `inspections.territoryId` (after territory seed) | Phase 2 augment decision |
| `controls[]` (filtered) | `inspections.customFields` jsonb | Phase 2 pilot decision |

## Sequencing

1. Stand up empty v2 schema, no data.
2. Seed `businesses` (Safe House, HCJ, Pest Heroes), `accounts` placeholder, `territories` (one row), `offices` (one row), `services` from ISN ordertypes.
3. User audit + import (Step 1).
4. Contact split + import (Step 2).
5. Property dedupe + import (heuristics from `04-field-mapping.md`).
6. Order migration (Step 3) with archive CSV.
7. Custom fields classification (Step 4) baked into Step 6 per-order.
8. Audit history import (Step 5) per migrated inspection.
9. Reschedule history reconstruction (Step 6).
10. Validation pass: row counts match, cancellation rates align with ISN UI counters, sampled orders round-trip equal.

## Validation checklist (placeholder)

- [ ] Imported user count = ISN active users post-audit
- [ ] Imported customer count = ISN client count minus migration cuts
- [ ] Imported inspection count for last 3 years = ISN count for same window
- [ ] Cancellation count in v2 = ISN deleted-orders count for last 6 months (the in-system slice)
- [ ] Archived cancellations CSV row count = ISN deleted-orders older than 6 months
- [ ] No orphaned FKs after import
- [ ] Sample 10 inspections, compare v2 fields to ISN raw response

## Open questions

1. Test/placeholder order detection heuristics: TBD when we look at the long tail.
2. Property dedupe: covered in `04-field-mapping.md`.
3. Whether to attempt InspectorLab event preservation in audit_log (currently surfaces in history, not in scope for scheduling slice).
