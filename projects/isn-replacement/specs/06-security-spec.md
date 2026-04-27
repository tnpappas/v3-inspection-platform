# Security Spec

_Status: STUB. Captures the principle-1 requirements set by Troy 2026-04-27 11:52 UTC. Filled out fully after the schema review locks._

## Principle

The system holds:

- Client PII (names, addresses, phones, emails)
- Property addresses and inspection findings (which can include security weaknesses of homes)
- Payment data
- Signed agreements (legally binding documents)
- Employee records
- Cross-business operational data

A breach is a business-ending event. Security is non-negotiable.

## Hard requirements

These apply to every table, every API surface, and every operational decision in the rebuild.

### S1. Row-level security at the database layer

Multi-business isolation is enforced in Postgres, not just in the API layer. Every business-scoped table gets an RLS policy keyed on `current_setting('app.current_business_id')` or equivalent session variable.

Pattern (illustrative, exact syntax fixed when the migration scripts land):

```sql
ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;

CREATE POLICY inspections_business_isolation
  ON inspections
  USING (business_id = current_setting('app.current_business_id')::uuid);

CREATE POLICY inspections_owner_bypass
  ON inspections
  USING (
    business_id = ANY(string_to_array(current_setting('app.user_business_ids'), ',')::uuid[])
  );
```

The application sets `app.current_business_id` and `app.user_business_ids` per-request from the authenticated session, before any query executes. Any code path that fails to set these gets zero rows back, which is the safe failure mode.

### S2. PII column markers in the schema

Every column that holds PII carries an inline comment marker:

```ts
email: varchar("email", { length: 255 }), // PII: contact_email
firstName: varchar("first_name", { length: 100 }), // PII: name
phoneMobile: varchar("phone_mobile", { length: 50 }), // PII: phone
```

Marker taxonomy:

- `PII: name` (first/last/display name)
- `PII: contact_email`
- `PII: phone`
- `PII: address`
- `PII: government_id` (license numbers, tax IDs)
- `PII: financial` (account numbers, payment tokens)
- `PII: location_precise` (latitude/longitude tied to a person/property)
- `PII: credentials` (password hashes, secret keys)

A grep over `shared/schema.ts` for `// PII:` produces the canonical list of regulated columns. Used by audit, export gate, and access control review.

### S3. Encryption at rest for PII

Where Postgres supports column-level encryption (via `pgcrypto` or a Neon-managed key escrow), PII columns are encrypted at the database layer. Where it does not, the application layer encrypts on write and decrypts on read using a key from the secrets store.

Decisions deferred to the security spec finalization:

- Which fields get column-level encryption vs whole-row vs whole-table.
- KMS provider (AWS KMS, GCP KMS, Hashicorp Vault, or other).
- Key rotation cadence.
- Search-on-encrypted-fields strategy (if any field needs to be searchable, e.g., email lookup, we plan a deterministic-encryption or HMAC-index pattern).

### S4. Soft delete by default

Every table holding PII or operational history has soft-delete semantics, not hard delete. Implementation pattern:

- `deletedAt timestamptz` column, null by default.
- `deletedBy uuid` column referencing users.id.
- `deleted_reason text` column for audit context.
- Default queries filter `deletedAt IS NULL`.
- A view `*_active` that hides deleted rows.
- A view `*_all` that includes them, used by admin and audit.
- Hard deletes are an explicit operation gated behind admin role + audit log entry + reason text.

Already proven necessary by the ISN cancellation pattern (platform issue #9): the inspections table retires through `cancelledAt`, not deletion.

### S5. Read audit on sensitive fields

The existing `audit_log` table covers writes. The security spec extends it: reads of sensitive fields also produce audit_log entries. Implementation:

- A read-audit middleware on routes that return PII.
- `action='read'` rows include the entity, the fields exposed, and the requesting user.
- Tunable noise floor: list views that show many records produce one aggregate audit row per request, not one per record. Detail views produce a per-record row.

Cost trade-off: ~2x audit_log write volume. Acceptable at our scale.

### S6. No secrets in schema columns

No table stores plaintext credentials, API keys, OAuth tokens, or anything else a secrets manager should hold.

Pattern: when a row needs a credential reference, it stores a **secret reference identifier** like `secret_ref varchar(255)` that points to a record in the secrets store. The actual secret value is fetched at runtime from the secrets manager.

Existing Replit project's `integrations_config` table is the place this matters most. Will be reviewed for compliance during the integration-config slice.

### S7. Session management

Passport.js (already in the stack) with the following:

- Sessions stored in Postgres via `connect-pg-simple`.
- Cookies: `httpOnly: true`, `secure: true` in production, `sameSite: 'strict'` (upgrade from current `'lax'` in the existing Replit project).
- Encrypted session payload at rest. The session table sits in the same DB but the payload is encrypted client-side before storage. (Decision to lock in spec finalization.)
- Idle timeout: 24 hours default, 1 hour for sensitive admin contexts.
- Absolute timeout: 30 days, configurable per business via `businesses.config`.
- Logout invalidates the server-side session immediately, not just clears the cookie.

The current Replit project uses `sameSite: 'lax'` and a 7-day max age. **The security spec tightens both before production launch.** Documented as a known delta.

### S8. Per-business export and access scoping

A user from HCJ cannot export Safe House data, regardless of their administrative role within HCJ. Enforcement points:

1. RLS at the database layer (S1) makes cross-business reads impossible at the source.
2. The export API checks `userIsInBusiness(userId, businessId)` before initiating any export job.
3. Export job records (which become a future `export_jobs` table) carry `business_id` and are themselves business-scoped.
4. Email/SMS notifications about exports include the business name to make cross-business slips obvious.

Exception: account-level owner roles (a future concept tied to the deferred `accounts` table) can export across businesses they own. This permission is not implemented day one and requires explicit user opt-in plus extra audit.

## Schema-level checklist (per-table)

Every table in `specs/01-schema.ts` carries a header comment confirming evaluation:

```
// Security: [PII fields | none], [encryption notes], [soft-delete: yes/no], [RLS: business-scoped | shared | system]
```

Tables that touch PII reference back to this spec. The security review is then "is this annotation correct" rather than "did we think about this."

## Critical invariants enforced at application layer

DB-layer constraints handle most isolation. A small number of invariants cannot be expressed as foreign keys or CHECK constraints because the relationship is polymorphic. These are enforced at the application layer; violations are bugs and must be caught by tests and runtime guards.

### INV-1: audit_log.account_id matches the entity's account

`audit_log.entity_type` plus `audit_log.entity_id` reference a row whose own `account_id` (direct or inherited) MUST equal `audit_log.account_id`. The schema cannot enforce this with a foreign key because `entity_id` is polymorphic.

Enforcement requirements:

1. **Insert path:** every code path that writes to `audit_log` runs through a single helper (`writeAuditLog(...)`) that validates the entity's account_id matches the supplied account_id before insert. Direct INSERTs that bypass the helper are a bug.
2. **Test coverage:** unit tests cover the helper's validation. Integration tests assert that inserting an audit_log row with a mismatched account_id throws.
3. **Runtime check (paranoid mode):** in production, a per-day reconciliation job samples N audit_log rows and joins back to the entity to verify account_id matches. Reports any drift. Catches accidental direct inserts that escaped review.
4. **PR review:** any direct `db.insert(auditLog)` in code review fails review unless explicitly justified as bypass.

Violations of INV-1 are categorized as a security incident, not a bug. Cross-account leak via misclassified audit rows is the failure mode. RLS policies on `audit_log` use `account_id` as the isolation key, so a misclassified row would surface in the wrong account's audit views.

### INV-2: RLS session variables set on every request

Application middleware sets `app.current_account_id`, `app.current_business_id`, and `app.user_business_ids` on the Postgres session before any business-table query runs. RLS policies depend on these. A query without them returns zero rows, which is a safe failure mode but means a missing middleware call manifests as silent data invisibility, not corruption.

## Compliance posture (informational)

We are not formally subject to HIPAA, GLBA, or PCI today. Property inspection PII does have **state-level breach notification obligations** in Virginia and most states we may operate in. The security model is built to be SOC-2-ready even if we never pursue SOC 2, because that posture covers the realistic threats: account takeover, accidental cross-tenant leak, insider misuse, and database compromise.

## Open items for spec finalization

1. KMS provider selection.
2. Encryption strategy per PII type (column-level vs row-level vs application-layer).
3. Read-audit aggregation rules (how to keep audit volume sane).
4. Session encryption-at-rest implementation.
5. Export job table design.
6. Penetration test cadence and bug-bounty policy.
