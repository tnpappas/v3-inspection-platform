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
- Absolute timeout: 30 days. **Configurable per account via `accounts.config.session.absoluteMaxDays`**, NOT per business. Reason: a user belongs to exactly one account (Pattern 1), so session lifetime is an account-level concern. Per-business overrides would be ambiguous for users with multi-business membership.
- Logout invalidates the server-side session immediately, not just clears the cookie.
- Session row carries `account_id`. RLS on the session table filters to the user's account. No cross-account session can ever resolve to a different account's user.

The current Replit project uses `sameSite: 'lax'` and a 7-day max age. **The security spec tightens both before production launch.** Documented as a known delta.

### S8. Per-business export and access scoping

A user from HCJ cannot export Safe House data, regardless of their administrative role within HCJ. Enforcement points:

1. RLS at the database layer (S1) makes cross-business reads impossible at the source.
2. The export API checks `userIsInBusiness(userId, businessId)` before initiating any export job.
3. Export job records (a future `export_jobs` table) carry `business_id` and are themselves business-scoped.
4. `audit_log.action='export'` is logged on every export, with `outcome='success' | 'denied' | 'failed' | 'partial'` capturing the result.
5. Email/SMS notifications about exports include the business name to make cross-business slips obvious.

Account-level admin can export across businesses they own with two extra requirements: explicit account-level role grant and an additional audit_log entry indicating the cross-business intent. Implementation deferred to the export-jobs slice.

### S9. Account isolation (the outer boundary)

A user from account X cannot read, write, or even infer the existence of records in account Y. This is the most damaging failure mode in the system; cross-account leak is treated as a security incident.

Enforcement layers, defense in depth:

1. **RLS at the database layer.** Every account-scoped table has a policy keyed on `current_setting('app.current_account_id')`. A query without that session variable set returns zero rows. Set it once per request in middleware before any business-table query runs.
2. **API layer.** Every authenticated request resolves the user's account_id from the session and sets `app.current_account_id` and `app.user_business_ids`. Failure to set these is a server-side bug that manifests as silent invisibility, which is the safe failure mode (no data leaks; some queries return empty).
3. **INV-1 invariant.** `audit_log.account_id` MUST match the audited entity's account. See "Critical invariants" section. Cross-account audit log writes are a violation.
4. **Slug uniqueness.** `accounts.slug` is globally unique; `businesses.slug` is unique per `(account_id, slug)`. URL paths starting with the slug never collide across accounts.
5. **Cross-account export prohibition.** A user cannot trigger any export, report, or background job that produces records from an account they do not belong to. The export API rejects the request before any data is read; the audit log captures the denied attempt with `outcome='denied'`.
6. **Login flow.** Email lookup is scoped to a single account. The login form either accepts a tenant-prefixed URL (e.g., `safehouse.app.example.com`) or includes an account selector. There is no global email index across accounts.
7. **Search.** Application-layer search functions accept account_id explicitly and pass it through every query; no "all-accounts search" exists in user-facing surfaces.

What fails secure: missing RLS session variable returns zero rows. Missing account_id on a query returns zero rows. Mismatched audit log account_id is caught by INV-1's daily reconciliation job and reported.

What does not fail secure (must be tested): direct database access by an authenticated administrator (production database connection). This is governed by infrastructure controls (VPN, audit, MFA on database tooling), not application logic.

### S10. MFA enforcement policy

MFA is implemented via `user_mfa_factors` (TOTP, backup codes, future WebAuthn). Enforcement policy is configurable per account.

**Default policy:**

- MFA is **optional** for all users by default.
- The UI prompts users to enable MFA after first login and tracks the prompt.
- For **production accounts** (any account with `accounts.plan_tier != 'internal'` or with `accounts.config.security.requireMfaForOwners = true`), MFA is **required for the `owner` role**. An owner without an enabled MFA factor cannot access account-level admin surfaces.

**Per-account configurable enforcement** (`accounts.config.security`):

- `requireMfaForOwners` (boolean, default true for non-internal plans)
- `requireMfaForRoles` (array of roleEnum values, default `[]` plus `["owner"]` per the rule above)
- `requireMfaForPiiAccess` (boolean, default false today; required to graduate the account to a higher security posture)
- `mfaGracePeriodDays` (integer, default 7) — how long after a role grant the user has to enroll before being locked out

**Application enforcement:**

- On login, check whether the user's effective roles require MFA per the account policy.
- If MFA is required and not enrolled, redirect to the enrollment flow.
- If MFA is required and the grace period has elapsed without enrollment, deny login with a clear message.
- After enrollment, login requires successful MFA challenge; bypass paths are limited to backup codes.

**Audit log signals:**

- MFA enrollment: `action='create'`, `entity_type='user_mfa_factor'`.
- MFA challenge success: `action='login'`, `outcome='success'`, with metadata indicating MFA was required and satisfied.
- MFA challenge failure: `action='login'`, `outcome='denied'`, with metadata indicating which factor failed.
- MFA bypass via backup code: `action='login'`, `outcome='success'`, with metadata flagging backup-code use (so operations can investigate if backup codes are being burned).

MFA secrets in `user_mfa_factors.secret` are encrypted at the application layer using a key from the secrets store (S6). Database-only encryption is insufficient because TOTP shared secrets are equivalent to the password if exposed.

## Schema-level checklist (per-table)

Every table in `specs/01-schema.ts` carries a header comment confirming evaluation:

```
// Security: [PII fields | none], [encryption notes], [soft-delete: yes/no], [RLS: business-scoped | shared | system]
```

Tables that touch PII reference back to this spec. The security review is then "is this annotation correct" rather than "did we think about this."

### S11. Permission model (two-tier RBAC with overrides)

Added 2026-04-27 alongside schema v3.1. The system uses two-tier role-based access control: granular permissions checked at request time, plus permission groups for operational ergonomics. Per-user grants and denies override role defaults. Resolution happens at session start.

#### Building blocks

- **Granular permissions** (table `permissions`): the atomic capabilities checked at request time. 50 entries today (`view.customer.pii`, `edit.inspection.assign`, `manage.billing`, etc.). System-managed reference table; seeded from a TypeScript constant via migration.
- **Permission groups** (table `permission_groups`): bundles of granular permissions for ergonomics. 9 entries today (`admin`, `account_admin`, `view`, `view_pii`, `financial`, `customer_data`, `operational`, `audit`, `export`). Flat structure (no nesting). System-managed.
- **Group membership** (table `permission_group_members`): junction (group_key, permission_key). System-managed.
- **Role defaults** (table `role_permissions`): per-account configuration of what each role gets by default. New accounts seed with sensible defaults; owner can adjust via `manage.account_config`.
- **Per-user overrides** (table `user_permission_overrides`): grants and denies per (user, business). Optional `expiresAt` for time-limited overrides matching the `user_roles` expiration pattern.

#### Resolution algorithm

```
effectivePermissions(user, business):
  let perms = empty set

  // Step 1: union of role defaults, expanding groups
  for each role in user_roles(user, business):
    for each row in role_permissions(account, role):
      if row.permission_key:
        perms.add(row.permission_key)
      else if row.group_key:
        perms.add_all(group_members(row.group_key))

  // Step 2: per-user grants (add), expanding groups
  for each row in user_permission_overrides(user, business, effect='grant', not expired):
    if row.permission_key:
      perms.add(row.permission_key)
    else if row.group_key:
      perms.add_all(group_members(row.group_key))

  // Step 3: per-user denies (subtract), expanding groups
  // Denies always win; granular deny removes a group-granted permission.
  for each row in user_permission_overrides(user, business, effect='deny', not expired):
    if row.permission_key:
      perms.remove(row.permission_key)
    else if row.group_key:
      perms.remove_all(group_members(row.group_key))

  return perms
```

**Key properties:**

- Groups expand at resolution time, not at storage time. Storage stays normalized.
- Granular denies always win over group grants. "Bob has admin group but is denied view.customer.pii" results in admin minus that one permission.
- Group denies expand to granular denies. "Deny export group" removes all `export.*` permissions.
- Computed once per session at login or at session refresh; cached in the request context.

#### Cache invalidation

The effective permissions cache invalidates when:

- A user's `user_roles` rows change (insert, delete, expire).
- The user's `user_permission_overrides` rows change.
- A `role_permissions` row changes for a role the user holds.
- A `permission_group_members` row changes for a group the user has been granted.
- The user's `accountId` or active business changes.

Cache TTL is set to session lifetime; explicit invalidation events listed above force a refresh on next request. Affected users see permission changes immediately on next request, no logout required.

#### Sensitive permissions and groups

A permission is `sensitive` when its use requires extra audit. Examples: `view.customer.pii`, `manage.billing`, all `export.*`, all `delete.*`, all `override.*`, `manage.account_config`, `manage.account`.

A group is `sensitive` when ANY contained permission is sensitive. Cached on `permission_groups.sensitive`; recomputed by the migration that mutates `permission_group_members`.

**Maintenance contract:** the migration helper `recomputePermissionGroupSensitivity(groupKey)` is called whenever `permission_group_members` is mutated for that group. The schema does not enforce this via trigger; it is the migration author's responsibility. A test asserts that for every group, `sensitive` matches the OR of contained permissions' `sensitive` flags. CI runs this test on every commit.

**Sensitive grant/use enforcement:**

- Granting a sensitive permission or group requires MFA re-verification when `accounts.config.security.requireMfaForPermissionGrants=true`.
- Sensitive grants produce `audit_log` entries with elevated retention (forever, not subject to standard retention).
- Use of sensitive permissions also triggers `audit_log` entries with `action='read_sensitive'` for read operations or the appropriate write `action` for mutations.
- The `audit_log.metadata` payload on a grant captures the expansion at grant time as `metadata.expanded_to`. This preserves what the grant meant historically, even if the group composition changes later.

#### Audit log entries for permission changes

New entity types: `permission`, `permission_group`, `permission_group_member`, `role_permission`, `user_permission_override`. The most-touched is `user_permission_override`.

**Granting a group:**

```
action: 'create'
entity_type: 'user_permission_override'
entity_id: <override pk>
changes: {
  after: {
    user_id: '<UUID>', business_id: '<UUID>', group_key: 'admin',
    effect: 'grant', reason: 'transition to leadership'
  },
  metadata: {
    expanded_to: ['manage.user', 'manage.user.roles', ...]  // captured at grant time
  }
}
```

**Granting/denying a granular permission:** same shape, `permission_key` populated, `group_key` null, no `expanded_to` in metadata.

**System-level catalog mutation (adding a permission to a group):**

```
action: 'create'
entity_type: 'permission_group_member'
changes: {
  after: { group_key: 'admin', permission_key: 'manage.new_thing' },
  metadata: {
    context: 'migration',
    migration_id: '...',
    affects_users: <count of users with this group granted>
  }
}
```

This migration event is logged at the system level (no business_id, no account_id) because it affects all accounts.

#### admin / account_admin maintenance pattern

`account_admin` is a flat superset of `admin`: it contains every permission `admin` contains, plus additional account-level permissions (`manage.account_config`, `manage.account`, `manage.business`).

**Maintenance rule:** when adding a permission to `admin`, also add it to `account_admin`. The schema does not enforce this; a test or migration script asserts the invariant. Drift between the two is a bug.

If this drift becomes operationally common, we revisit by introducing nested groups (deferred design choice; rejected today for resolution-algorithm simplicity).

#### Scope vs permission distinction

**Permissions express what a user can do. Scope expresses what entities the user can act on. Scope is enforced in application logic, not in the permission catalog.**

Example: a technician has `view.customer.pii` granted via the operational group, but scope-enforced in code to only inspections where the technician is lead or secondary. The permission table cannot express "for own work only"; that's an application concern.

Do not add scope-permission combinations to the permissions catalog (e.g., do not add `view.customer.pii.own_inspections` as a separate permission). The catalog stays clean; scope rules live alongside the permission check in the application layer.

#### PII masking pattern (runtime API behavior)

**Storage:** PII columns are stored unredacted in the database. PII redaction is applied in the API serialization layer based on the requesting user's effective permissions.

**Behavior:**

- Permission `view.customer.pii` (or membership in a group containing it, like `customer_data` or `view_pii`) bypasses redaction.
- Otherwise, PII fields are returned as masked strings in API responses.

**Redaction conventions:**

- Email: `j****@example.com` (first character + asterisks + domain).
- Phone: `***-***-1234` (last 4 digits visible).
- Address: `*** Main St` for street; city/state/zip visible (zip is geographic, not personally identifying alone).
- Name: full name visible by default (the `view.customer.pii` permission is about contact details, not identity). If a future requirement demands name-masking, the permission `view.customer.name` becomes a separate gate.
- License (`PII: government_id`): masked entirely (`***-***-****`) when the user lacks `view.customer.pii`.
- Notes (free text): redacted entirely (`[redacted]`) when the user lacks `view.customer.pii`, since notes can contain unstructured PII.

**Why runtime, not field-level encryption:**

Field-level encryption was considered (S3) but is deferred. Runtime masking is sufficient for the threat model: an authenticated user with the right permissions sees PII; an authenticated user without those permissions does not. Database-layer attackers (compromised DB credentials, leaked backup) are addressed by S3 once we lock the encryption strategy.

**Implementation note:** the API serialization layer (likely a middleware or a Drizzle query helper) applies redaction. The application MUST NOT manually unredact PII based on partial logic; it goes through the centralized helper. A test asserts that a user without `view.customer.pii` cannot retrieve unmasked PII through any API path.

This pattern is operationally significant because it means **future developers should not implement field-level encryption thinking it is required**. Encryption is one approach; runtime masking is what we use today.

#### System user pattern

Each account has exactly one synthetic system user (table `users` with `is_system=true`). The system user is account-scoped, NOT global; cross-account FK references through `createdBy` cannot leak account boundaries because RLS policies on `users` filter by `account_id`.

**Schema fields on the system user:**

- `id`: standard UUID, generated by the seed migration.
- `accountId`: the account the system user belongs to (one per account).
- `isSystem`: TRUE.
- `email`: `system@<account-slug>.local` (informational; not used for auth identification).
- `displayName`: `"System (seed)"` or similar.
- `passwordHash`: NULL.
- `username`: NULL.
- `status`: `active`. The user appears in FK lookups; login is rejected by application logic, not by status.
- `firstName`, `lastName`, contact fields: NULL.
- `emailVerifiedAt`: NULL (never verified; never sends notifications).

**Identification:** queries that need to find or exclude the system user use `WHERE is_system = TRUE` (or `WHERE is_system = FALSE` for normal-users-only views). Email-pattern matching is NOT used; `is_system` is the canonical signal.

**Login enforcement:** the Passport authentication flow rejects any login attempt where the matched user has `is_system = TRUE`, regardless of whether the supplied password would otherwise be valid (it cannot be valid because `password_hash` is NULL). The rejection produces an `audit_log` entry with `action='login'`, `outcome='denied'`, `metadata.reason='system_user_login_attempted'`. Any such attempt indicates either a bug in the application code or an attempted privilege escalation; alerts fire to the account Owner per S10 sensitive-action policy.

**Use cases for the system user:**

- `createdBy` / `lastModifiedBy` on rows inserted by the seed migration (businesses, services, role_permissions, etc.) where no human user exists yet.
- `userId` on `audit_log` rows produced by background workers, scheduled jobs, and migrations.
- `grantedBy` on `user_roles` rows seeded at account-creation time (alternative to NULL for the seed grant; either is acceptable, but `is_system` user gives the audit log a non-null actor).
- `assignedBy` on `inspection_inspectors`, `cancelledBy` on `inspections` for system-driven cancellations (e.g., never-confirmed-with-customer auto-cancellation when implemented).

**RLS interaction:** the system user does not bypass RLS. Queries running under the system user's session (when application code runs background work "as" the system user) still set `app.current_account_id` to the system user's account_id. Cross-account work requires the application to run multiple sessions, one per account. There is no "superuser" mode at the application layer.

**One per account invariant:** the schema enforces this via partial unique index `users_account_system_unique ON users (account_id) WHERE is_system = TRUE`. A second system user insert in the same account fails at the database layer.

#### Implicit role denies pattern

The `role_permissions` table carries grants only. Roles never have explicit denies in their default mapping. When a role conventionally lacks certain permissions (e.g., bookkeeper denied `view.customer.pii`, viewer denied all `edit.*`), those denies are NOT seeded into `role_permissions`.

Instead, **implicit role denies are materialized as `user_permission_overrides` rows at user-creation time, not stored on `role_permissions`**.

**Pattern:**

When a user is created (via `createUser` API or migration import) and granted a role, the application:

1. Inserts the `user_roles` row.
2. Looks up the role's convention-based denies (defined in a TypeScript constant `ROLE_IMPLICIT_DENIES`).
3. Inserts a `user_permission_overrides` row per implicit deny, with `effect='deny'`, `grantedBy=<system-user-id-or-creator>`, `reason='role default deny: <role-name>'`.
4. All inserts are audit-logged with `action='create'`, `entity_type='user_permission_override'`.

**Examples (per spec 04 and the v3.1 design):**

- New `bookkeeper` user: implicit denies for `view.customer.pii`. The bookkeeper sees customer names but not PII.
- New `viewer` user: implicit denies for all `edit.*`, `create.*`, `delete.*`, `manage.*`, `export.*`, `override.*`, `view.customer.pii`, `view.financial`, `view.audit_log`, `view.cross_business`, `view.inspection.internal_notes`.
- New `client_success` user: implicit denies for `delete.*`, `cancel.inspection`, all `manage.*`. (Conservative; the `view`+`view_pii`+individual permissions in their grant set already exclude most of these, but explicit denies guarantee defense-in-depth.)

**Why this pattern, not denies-on-role:**

- Roles describe what a user can do by default. `role_permissions` is a grants-only model.
- Per-user denies live in one place (`user_permission_overrides`), simplifying the resolution algorithm.
- An admin can revoke an implicit deny for a specific user (e.g., grant a junior bookkeeper `view.customer.pii` for a specific case) by deleting the deny override and adding a grant.
- The audit trail captures "this deny was applied at user creation by the system" as a normal `user_permission_override` row, queryable like any other override.

**Maintenance contract:** the `ROLE_IMPLICIT_DENIES` constant lives in `specs/shared/schemas/permissions-seed.ts` (added v3.1.1). When adding a role or changing implicit denies, update the constant and write a migration that retroactively applies new denies to existing users with that role. CI test asserts every role's implicit denies reference valid permission keys.

#### Permission denial UX

When a user attempts an action without the required permission:

1. UI elements are hidden or disabled at render time. Users do not see buttons they cannot click.
2. If a user reaches an action endpoint via direct URL or API call without the permission, the API responds with HTTP 403 plus a structured error: `{ "error": "permission_denied", "required": ["manage.billing"], "missing": ["manage.billing"] }`.
3. The denial produces an `audit_log` entry with `action=<intended action>`, `outcome='denied'`, `metadata.required_permissions=[...]`. This catches probe attempts.
4. Three or more denials within 1 minute from the same session trigger an alert to the account owner; configurable per `accounts.config.security.permissionDenialAlerts`.

## Critical invariants enforced at application layer

Documented separately from S1-S11 because these are application-layer enforcement requirements that supplement DB-layer constraints, not policy statements.


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
