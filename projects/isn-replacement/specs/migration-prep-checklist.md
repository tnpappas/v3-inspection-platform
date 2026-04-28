# Pre-Migration Verification Checklist

_Status: LOCKED 2026-04-28. Work through this document before running any migration script against a production database. Every item must be checked off and documented before the go/no-go call._

This checklist resolves the 6 open questions carried forward from spec 05, plus operational readiness items specific to Safe House.

---

## Section 1: Data investigation (do these before migration-prep day)

### 1.1 Foundation map verification

**Open question #3 from spec 05.**

The foundation UUID → string mapping in `migrate-properties.ts` was inferred from property context. Confirm these two values against the ISN admin panel before running a production migration.

**Steps:**

1. Log into the ISN admin panel as Troy.
2. Navigate to Settings → Property Attributes → Foundation Types (or similar path).
3. Confirm the displayed names match:
   - `5d8fbc5c-b2d3-4319-9610-ed962af3f25d` → **crawl_space** (best-guess from 10/23 sampled orders)
   - `d7010b32-2d6c-42bf-959b-a5935b09b247` → **slab** (best-guess from 5/23 sampled orders)
4. If either is wrong, update `FOUNDATION_MAP` in `specs/migration/migrate-properties.ts` and re-run `migrate-properties.ts` (idempotent).

- [ ] Foundation UUID `5d8fbc5c...` confirmed as: _______________
- [ ] Foundation UUID `d7010b32...` confirmed as: _______________
- [ ] `FOUNDATION_MAP` updated if corrections needed

---

### 1.1b Verify ISN field name consistency (CRITICAL — do this first)

**Confirmed issue from Phase 3 crawl (2026-04-28):** ISN uses different field names for the same concept across entity types. `migrate-contacts.ts` has been corrected, but verify the fix before running.

Expected field names per entity:

| Concept | Users | Clients | Agents | Escrow officers |
|---|---|---|---|---|
| First name | `firstname` | `first` | `first` | `firstname` |
| Email | `emailaddress` | `email` | `email` | `email` |
| SMS opt-in | `sendSMS` | `send_sms` | `sendsms` | (none) |
| Photo | `photourl` | (none) | `img` | (none) |
| Mobile phone | `mobile` | `mobilephone` | `mobilephone` | `cellPhone` |

```bash
# Spot-check: pull one client and one agent, verify field names match the table above
curl -s -u "$ISN_ACCESS_KEY:$ISN_SECRET_ACCESS" \
  "https://inspectionsupport.net/safehouse/rest/client/<any_client_uuid>" | python3 -m json.tool | head -20
curl -s -u "$ISN_ACCESS_KEY:$ISN_SECRET_ACCESS" \
  "https://inspectionsupport.net/safehouse/rest/agent/<any_agent_uuid>" | python3 -m json.tool | head -20
```

- [ ] Client fields confirmed: `first`, `last`, `display`, `email`, `mobilephone`, `homephone`, `workphone`, `send_sms`, `send_email`
- [ ] Agent fields confirmed: `first`, `last`, `display`, `email`, `mobilephone`, `workphone`, `sendsms`, `img`
- [ ] Escrow officer fields confirmed: `firstname`, `lastname`, `displayname`, `email`, `phone`, `cellPhone`

### 1.2 Pull `/clients` deep crawl

**Open question #5 from spec 05.**

Phase 2 discovery did not pull full client records (only order-embedded references were used). The `migrate-contacts.ts` script calls `GET /client/{id}` inline, but the client stub list (`GET /clients`) was not reviewed.

**Steps:**

1. Call `GET /clients` and confirm the endpoint format matches what `migrate-contacts.ts` expects.
2. Pull a sample of 5–10 full client records via `GET /client/{id}` and compare the field names to `specs/04-field-mapping.md` "ISN /clients" section.
3. If any field names differ from the mapping, update `migrate-contacts.ts` and `specs/04-field-mapping.md`.

```bash
# Quick verification:
curl -s -u "$ISN_ACCESS_KEY:$ISN_SECRET_ACCESS" \
  "https://inspectionsupport.net/safehouse/rest/clients" | python3 -m json.tool | head -30
```

- [ ] `/clients` endpoint confirmed working
- [ ] Sample client detail pulled and field names verified
- [ ] `migrate-contacts.ts` updated if field names differ

---

### 1.3 Pull `/agencies` deep crawl

**Open question #6 from spec 05.**

`migrate-contacts.ts` imports agencies as stubs (using the UUID from agent records) with placeholder names like `ISN Agency {uuid[:8]}`. The full agency records with real names must be pulled and names updated post-import.

**Steps:**

1. After running `migrate-contacts.ts`, call `GET /agencies` and `GET /agency/{id}` for each unique agency UUID found in the agent records.
2. Update each `agencies` row in v3 with the real name, phone, email, and address.
3. Either add an agency-name backfill step to `migrate-contacts.ts` or run as a separate cleanup script post-import.

```bash
# Check endpoint availability:
curl -s -u "$ISN_ACCESS_KEY:$ISN_SECRET_ACCESS" \
  "https://inspectionsupport.net/safehouse/rest/agencies" | python3 -m json.tool | head -20
```

- [ ] `/agencies` endpoint tested and format confirmed
- [ ] Plan for agency name backfill documented (inline or separate script)
- [ ] Agency names backfilled after `migrate-contacts.ts` completes

---

### 1.4 Define test/placeholder order detection thresholds

**Open question #1 from spec 05.**

Current heuristic in `migrate-orders.ts`:

```ts
// Test/placeholder: no client AND totalFee=0 AND squareFeet=0
if (!order.client && totalFee === 0 && sqft === 0) → skip
```

This is approximate. Before production migration:

**Steps:**

1. Run a count against ISN API to see how many orders match this heuristic:
   ```bash
   # Pull a sample of skipped candidates and review manually
   ```
2. Adjust the heuristic if too many valid orders are caught, or too many test orders slip through.
3. Update `shouldSkipOrdertype` in `migrate-orders.ts` if changes needed.
4. Document the final threshold in this checklist.

- [ ] Test/placeholder heuristic reviewed against a sample of ISN orders
- [ ] Final threshold documented: _______________
- [ ] `migrate-orders.ts` updated if threshold changed

---

### 1.5 Decide InspectorLab event preservation

**Open question #2 from spec 05.**

Phase 2 augment discovered "InspectorLab Triggered" events in ISN order history. Currently not migrated. InspectorLab appears to be a sample analysis or compliance tool integration.

**Decision needed:** Does Safe House need this data in v3?

- If **no**: mark this item done.
- If **yes**: add a filter in `migrate-history.ts` to capture InspectorLab events in `audit_log.changes.metadata.inspector_lab_triggered`, or write a separate backfill script.

- [ ] Decision made: preserve / skip (circle one)
- [ ] If preserve: implementation approach documented and script updated

---

### 1.6 Confirm schedule provenance fallback rule

**Open question #4 from spec 05.**

For orders with sparse ISN history (older orders, minimal event log), the schedule creation event may not exist in `audit_log` after the history import. The spec documents a fallback:

> Populate `inspections.createdBy` from the ISN `scheduledby` field if the audit_log import does not yield a create event.

**Confirm:** is this fallback active in `migrate-orders.ts`?

Check `migrate-orders.ts` for the `createdBy` population logic:
- `isnOrder.scheduledby` → lookup via `users.isnSourceId` → set as `inspections.createdBy` when not null.
- System user as the final fallback when `scheduledby` is also null.

- [ ] Confirmed: `migrate-orders.ts` uses `scheduledby` as fallback for `createdBy`
- [ ] Confirmed: system user is the final fallback

---

## Section 2: Environment readiness (day-of-migration)

### 2.1 `migration/.env.migration` populated

After running `seed.ts`, verify the env file contains all required values.

```bash
cat migration/.env.migration
```

Expected output (with real UUIDs):

```
MIGRATION_ACCOUNT_ID=<uuid>
MIGRATION_SAFEHOUSE_BIZ_ID=<uuid>
MIGRATION_HCJ_BIZ_ID=<uuid>
MIGRATION_PEST_BIZ_ID=<uuid>
SEED_ACCOUNT_SLUG=pappas
```

- [ ] `MIGRATION_ACCOUNT_ID` populated
- [ ] `MIGRATION_SAFEHOUSE_BIZ_ID` populated
- [ ] `MIGRATION_HCJ_BIZ_ID` populated
- [ ] `MIGRATION_PEST_BIZ_ID` populated
- [ ] Source command tested: `set -a && source migration/.env.migration && set +a`

---

### 2.2 ISN API credentials active

```bash
curl -s -u "$ISN_ACCESS_KEY:$ISN_SECRET_ACCESS" \
  "https://inspectionsupport.net/safehouse/rest/me" | python3 -c "import json,sys; d=json.load(sys.stdin); print('OK:', d.get('status'), d.get('me',{}).get('emailaddress'))"
```

- [ ] ISN API returns `status: ok`
- [ ] Authenticated user is Troy's account (not expired/revoked)

---

### 2.3 Database connectivity and schema version

```bash
psql $DATABASE_URL -c "\d+ inspections" | head -5    # confirms inspections table exists
psql $DATABASE_URL -c "SELECT COUNT(*) FROM permissions;"  # confirms seed tables exist
```

- [ ] Database connection works
- [ ] v3.1.2 schema applied (inspections table present, permissions table present)
- [ ] `reschedule_history_unique_reschedule_idx` constraint present:
  ```sql
  SELECT indexname FROM pg_indexes WHERE tablename = 'reschedule_history';
  ```

---

### 2.4 Run validate-migration.ts against test database first

**Do not run the migration directly against production. Run against a staging or test database first.**

```bash
DATABASE_URL=<test_db_url> npx tsx specs/migration/validate-migration.ts
```

Review the `migration/validation-report.txt` output. All checks should pass.

- [ ] Test database seeded and migrated successfully
- [ ] `validate-migration.ts` passes all checks on test database
- [ ] Spot-check: 10 sampled inspections round-trip correctly (ISN detail vs v3 row)
- [ ] `archived-cancellations.csv` row count matches expected

---

## Section 3: Post-migration readiness (before going live)

### 3.1 Technician availability configured

⚠️ **The migration scripts do NOT populate technician availability.** Without it, the slot-finding algorithm returns no results and the system cannot schedule new inspections.

For each active inspector:

- [ ] `technician_hours` rows created (recurring weekly schedule)
- [ ] `technician_zips` rows created (ZIP coverage with priorities)
- [ ] `technician_time_off` rows created for any known upcoming time off

Spot-check before go-live:

```bash
curl -s -H "Cookie: $SESSION_COOKIE" \
  "$APP_URL/api/calendar/available-slots?businessId=$MIGRATION_SAFEHOUSE_BIZ_ID&from=<tomorrow>&to=<next_week>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('Slots returned:', len(d.get('data', [])))"
```

- [ ] At least one inspector has availability configured
- [ ] Slot finder returns > 0 slots for the next 14 days
- [ ] All primary inspectors have availability configured before final ISN cutover

---

### 3.2 Troy's user account verified

- [ ] Can log in to v3 system with Troy's email
- [ ] Has `owner` role in all three businesses
- [ ] MFA enrolled (required per `accounts.config.security.requireMfaForOwners=true`)
- [ ] Can see all inspections imported from ISN
- [ ] Can create a test inspection end-to-end

---

### 3.3 Permission spot-checks

- [ ] A sample inspector can log in and see their schedule
- [ ] A sample bookkeeper can see financial data but NOT customer PII (email/phone masked)
- [ ] A sample viewer cannot create or edit any record

---

### 3.4 ISN parallel-run plan

Before full ISN cutover, run both systems in parallel for at least one week:

- [ ] New inspections booked in v3
- [ ] ISN kept in read-only mode (do not create new orders in ISN during parallel run)
- [ ] Daily spot-check: compare ISN upcoming schedule vs v3 upcoming schedule
- [ ] Signoff from Troy before ISN deactivation

---

## Sign-off

Migration operator: _______________________

Date of production migration: _______________________

All items above checked: ☐ Yes

Notes: _______________________________________________
