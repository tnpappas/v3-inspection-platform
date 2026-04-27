# Session Handoff (2026-04-27 → 2026-04-28)

_Written 2026-04-27 23:34 UTC at end of session. Pick up tomorrow on a fresh OpenClaw session with Sonnet._

## Tomorrow's startup procedure

1. Open a fresh OpenClaw session (NOT a continuation of today's; today is at 674k context which exceeds Sonnet's 200k limit).
2. Switch model to `anthropic/claude-sonnet-4-6` immediately. Verify with `/status` after the switch.
3. Have Hatch read this file (`projects/isn-replacement/handoff.md`) plus the locked specs in `projects/isn-replacement/specs/`.
4. Proceed with **spec 02 (API contract, OpenAPI 3.0 YAML)**.

## What was locked in this session

In commit order:

| Commit | What |
|---|---|
| (earlier) | Foundation phase complete: v3 schema locked at git tag `v3-schema-locked`, specs 06/07/08 locked, decisions docs locked |
| `516ee8d` | Spec 04 (field mapping) LOCKED with account-agnostic principles + per-account-config + post-pass-derivation patterns |
| `7bf7812` | Spec 03 (user stories + workflows) LOCKED |
| `848487e` + `8a9c971` + `0209f25` | Schema v3.1: two-tier RBAC additions (5 new tables: permissions, permission_groups, permission_group_members, role_permissions, user_permission_overrides) plus permissionEffectEnum, audit entity types, explanatory comments |
| `2b3dad8` | `ON_HOLD_PLACEHOLDER_AT` constant (9999-12-31 23:59:59 UTC) added to schema; W6 documentation in spec 03 |
| `41f573a` | Spec 06 S11 permission model section + schema rationale RBAC architecture + migration plan Step 0 seeding + permissions-seed.ts (50 permissions, 9 groups, 62 group memberships, default role mappings, CI test helpers) |
| `cbdc5db` | Schema v3.1.1: `users.is_system` boolean column + spec 06 system user pattern subsection + spec 06 implicit role denies pattern subsection + permissions-seed.ts cleanup (removed duplicate view.report on client_success) + 2 new CI test functions (verifyPermissionKeyExistence, verifyGroupKeyExistence) + ROLE_IMPLICIT_DENIES constant (29 entries) + migration plan Step 5.5 updated to use is_system flag |
| `790add2` | TOOLS.md: model-switch verification lesson |
| `346af8c` | TOOLS.md: corrected Sonnet model name (4-6 not 4-5) and context window constraint |

**Schema state at session end:** v3.1.1, locked. 32 tables, 18 enums, 61 PII markers, 7 soft-delete tables, 8 tables with direct `account_id`, 3 CHECK constraints. Git tag `v3-schema-locked` still valid (additive changes only).

**Specs state at session end:**

- `01-schema.ts` v3.1.1 LOCKED
- `01-schema-rationale.md` LOCKED (with v3.1 RBAC architecture + migration design principles + bill-to-closing + Inspections conventions sections)
- `03-user-stories.md` LOCKED (30 stories + 7 Mermaid workflows + permission `requires:` lines + O-6, OM-6, B-1..B-5)
- `04-field-mapping.md` LOCKED
- `05-migration-plan.draft.md` (still draft; Step 0 seeding expanded; locking happens after spec 02)
- `06-security-spec.md` (S1-S11 complete with system user + implicit denies + PII masking subsections)
- `07-scalability-spec.md` (refreshed with v3 hot paths + cross-business customer query + read_sensitive multiplier on partition math)
- `08-multi-business-extensibility-spec.md` (layered worked examples + organizations future expansion)
- `shared/schemas/account-config.ts` (Zod for accounts.config)
- `shared/schemas/business-config.ts` (Zod for businesses.config)
- `shared/schemas/permissions-seed.ts` (50 permissions, 9 groups, 62 memberships, default role mappings, 29 implicit denies, 4 CI test helpers)

## Model-switch lesson

**Captured in `~/.openclaw/workspace/TOOLS.md`:**

- Always pull `/status` after a model-switch attempt to verify what is actually running. Do NOT assume a failed switch reverted to a previous model.
- The 3-hour run on Opus when Sonnet was expected (today, 18:09-21:27 UTC) cost ~5x what Sonnet would have cost. Avoidable with the verify-after-switch discipline.

## Correct model names in this OpenClaw deployment

| Alias / Variant | Result |
|---|---|
| `anthropic/claude-opus-4-7` | ✅ ALLOWED (default, 1M context) |
| `anthropic/claude-sonnet-4-6` | ✅ ALLOWED (200k context) |
| `claude-sonnet-4-5` | ❌ Rejected ("Model is not allowed") |
| `anthropic/claude-sonnet-4-5` | ❌ Rejected |
| `sonnet-4-5` | ❌ Rejected |
| `anthropic/claude-sonnet-4-7` | ❌ Rejected |

**Tomorrow:** use `anthropic/claude-sonnet-4-6` for the model switch.

## Context window constraint

**Sonnet 4-6: 200k tokens. Opus 4-7: 1M tokens.**

This session is at ~674k tokens. Sonnet cannot continue this session (would be at 337% of its limit). That is why we are stopping and starting fresh tomorrow.

**Implication for tomorrow:** spec 02 starts in a fresh, low-context Sonnet session. Hatch reads the locked specs to rebuild context, then drafts spec 02. The locked specs are the source of truth; this handoff doc plus a brief recap should be enough.

## Exact next step: spec 02 (API contract, OpenAPI 3.0 YAML)

**File path:** `projects/isn-replacement/specs/02-api-contract.draft.yaml` (then locked to `02-api-contract.yaml`).

**Estimated effort:** 4.5 hours of focused work per the building-phase estimate.

**Coverage required:**

- Every endpoint for the scheduling slice
- Aligned with Express `/api/*` routing convention from the existing Replit project
- Auth: Passport sessions (already in stack)
- Schemas reference Drizzle types from `01-schema.ts`
- Error patterns
- Cursor pagination contract for unbounded lists
- Permission requirements for each endpoint (referencing the 50 granular permissions in `permissions-seed.ts`)
- RLS-related response codes (403 vs 404 hide pattern)

## Pre-decisions for spec 02 already made in this session's chat history

These are decisions Hatch should NOT re-litigate; just apply them in the API contract.

### Auth model

- Passport.js with local strategy (email + password).
- Session cookies via `connect-pg-simple` (Postgres-backed sessions).
- Cookie attributes: `httpOnly: true`, `secure: true` in production, `sameSite: 'strict'`.
- Encrypted session payload at rest (decision finalized in S7; details in spec 06).
- Idle timeout: 24 hours default. Absolute timeout: 30 days. Both configurable per account via `accounts.config.session`.
- MFA enforcement per account policy in `accounts.config.security` (S10).
- The Passport authentication flow MUST reject any user with `is_system=true`, regardless of credentials. Audit-logged with `outcome='denied'`.

### Error envelope

Standard JSON shape for all error responses:

```json
{
  "error": "permission_denied",      // machine-readable error code
  "message": "Human-readable message",
  "required": ["manage.billing"],     // optional, for permission_denied: which permissions were checked
  "missing": ["manage.billing"],      // optional, for permission_denied: which were missing
  "request_id": "<uuid>"              // for forensic correlation; matches audit_log.requestId
}
```

HTTP status codes follow REST conventions:
- 200/201 for success
- 400 for client validation errors
- 401 for unauthenticated
- 403 for authenticated but unauthorized (or 404, see below)
- 404 for not found
- 409 for conflict (unique constraint, optimistic concurrency)
- 422 for semantic validation failures (e.g., reschedule violates business hours)
- 429 for rate-limited
- 500 for server errors (with sanitized message)

### Pagination

Per spec 07 Sc2:

- **Cursor-based** on unbounded lists: `inspections`, `audit_log`, `email_logs`, `email_jobs`, `agreements`, `payment_events`, `automation_logs`, `communication_log`, `inspection_notes`, `customers`, `properties`, `transaction_participants`.
- **Offset/limit** on bounded lists: `users`, `services`, `businesses`, `email_templates`, etc.

Cursor format: opaque base64-encoded `{ createdAt: ISO, id: UUID }`. Response shape:

```json
{
  "items": [...],
  "next_cursor": "<base64>" | null,
  "has_more": true | false
}
```

Offset/limit query params: `?limit=50&offset=0`. Default `limit=50`, max `limit=200`.

### 404 vs 403 hide pattern

Per S9 (account isolation):

- A user querying a record that exists but belongs to a different account: respond **404** (do not reveal existence).
- A user querying a record in their own account but lacking the permission: respond **403** with the permission_denied error envelope.
- A user querying a record that does not exist: respond **404**.

This prevents account enumeration attacks. RLS at the DB layer means cross-account queries return zero rows, which the API layer translates to 404.

### Permission references on endpoints

Every endpoint in spec 02 specifies its required permission(s) using the format from spec 03:

```yaml
x-required-permissions:
  all: ["edit.inspection.assign"]
```

Or for compound requirements:

```yaml
x-required-permissions:
  all: ["edit.inspection", "view.customer.pii"]
```

The `x-required-permissions` extension is non-standard but useful for code generation. Document the convention in spec 02's intro.

### PII masking

Per S11 (PII masking pattern):

- API responses for routes that return customer/property PII apply masking based on the requesting user's effective permissions.
- Spec 02 documents the masked response shape AND the unmasked response shape; the requesting user's permissions determine which they get.
- An `x-pii-fields` extension on response schemas marks which fields are subject to masking. Code generation uses this to apply the redaction helper consistently.

### `on_hold` inspection scheduledAt

- `inspections.scheduledAt` for `on_hold` rows is `9999-12-31 23:59:59 UTC` (the `ON_HOLD_PLACEHOLDER_AT` constant).
- API serialization MUST detect this sentinel and return it as `null` or a structured `"pending"` indicator, NOT the literal year-9999 string.
- Spec 02 documents this in the inspection response schema.

## Open architectural questions still pending (for spec 02 to flag, not resolve)

Some of these were captured in spec 03 open questions; carrying forward for visibility.

1. **Realtor portal authentication.** No portal login model defined yet. Spec 02 documents future endpoints with `x-status: future` markers; auth design is a separate slice.
2. **Client portal authentication.** Same as realtor portal.
3. **WebSocket vs polling for dispatcher dashboard.** Spec 02 documents REST-over-poll today; WebSocket spec is separate when implemented.
4. **Drive-time integration.** Out of scope for spec 02; surfaces in inspector daily view as static data.
5. **Slot algorithm cache backend.** Out of scope for the API contract; the algorithm is a service-layer function.
6. **Bulk operations rate limits.** Spec 02 documents rate-limit headers but defers specific limits to operational tuning.
7. **No-show fee policy.** Defers to per-business config.
8. **Account-level dashboard cross-business UNION strategy.** Spec 02 documents the endpoint shape; query strategy is implementation detail.
9. **Custom fields UI surfacing rules.** Spec 02 returns the raw `customFields` jsonb; UI rendering rules are not API-layer concerns.
10. **Field-level encryption strategy (S3).** Deferred. Spec 02 documents the masking pattern (S11) which is what we use today.

## After spec 02

Per the agreed sequence (Troy 2026-04-27 16:56 UTC):

- Spec 02 (API contract) — tomorrow
- Spec 05 (migration plan lock pass)
- Migration script files in `specs/migration/`

Pause for review at the completion of spec 02, then spec 05, then migration scripts (in that order, per Troy).

## Files Hatch should read tomorrow before starting spec 02

In order:

1. This handoff doc (`projects/isn-replacement/handoff.md`)
2. `projects/isn-replacement/specs/01-schema.ts` (v3.1.1 schema, the source of truth for entity shapes)
3. `projects/isn-replacement/specs/03-user-stories.md` (the stories that drive endpoint design)
4. `projects/isn-replacement/specs/04-field-mapping.md` (ISN→v3 mapping; relevant for migration-related endpoints if any)
5. `projects/isn-replacement/specs/06-security-spec.md` (auth, RLS, S9, S10, S11 all relevant)
6. `projects/isn-replacement/specs/07-scalability-spec.md` (pagination strategy Sc2; hot-path queries Sc5)
7. `projects/isn-replacement/specs/shared/schemas/permissions-seed.ts` (the 50 permissions referenced by every endpoint)

The existing Replit project's `server/routes.ts` (in `projects/isn-replacement/replit-snapshot/`, gitignored locally) shows the current API surface that spec 02 evolves from. Reference for naming conventions and route structure.

## What NOT to do tomorrow

- Do not re-litigate the architectural decisions captured in this handoff or in the locked specs.
- Do not switch to Opus unless a complex architectural call surfaces. Spec 02 is structured documentation work; Sonnet is appropriate.
- Do not skip the handoff read. The session context is gone; the locked specs are the only source of truth.
