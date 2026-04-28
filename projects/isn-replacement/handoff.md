# Session Handoff (2026-04-28 → next session)

_Written 2026-04-28 11:00 UTC at end of session. Session stopped due to context size. Pick up on a fresh Sonnet session with the procedure at the bottom of this doc._

---

## TL;DR

- **Foundation phase complete.** Schema locked at v3.1.1, three specs locked, RBAC system designed and seeded.
- **Building phase ~50% complete.** Spec 03 and Spec 04 locked. Spec 06 has S11 added. Schema rationale captured. Migration plan has Step 0/5.5 expansions. `permissions-seed.ts` written.
- **Next deliverable:** Spec 02 (API contract, OpenAPI 3.0 YAML for the scheduling slice).
- **~16 hours of focused work remaining:** Spec 02, Spec 05 lock pass, migration scripts.

---

## Session inventory: locked artifacts

In commit order (most recent first):

| Commit | Artifact | One-line description |
|---|---|---|
| `568267d` | `handoff.md` (yesterday's) | Previous handoff doc; superseded by this one |
| `346af8c` | `TOOLS.md` | Corrected Sonnet model name (4-6 not 4-5); added 200k context window constraint |
| `790add2` | `TOOLS.md` | Captured model-switch verification lesson; allowed-models state |
| `cbdc5db` | Schema v3.1.1 + spec 06 + migration plan + permissions-seed | `users.is_system` column, system user pattern, implicit role denies pattern, 2 new CI tests, `ROLE_IMPLICIT_DENIES` constant |
| `41f573a` | Spec 06 S11 + schema rationale + migration plan + permissions-seed | S11 permission model, RBAC architecture rationale, Step 0 seeding, `permissions-seed.ts` (50 permissions, 9 groups, default role mappings) |
| `7bf7812` | Spec 03 LOCKED | User stories LOCKED; `.draft` suffix dropped; status header updated |
| `2b3dad8` | Schema + spec 03 | `ON_HOLD_PLACEHOLDER_AT` constant (9999-12-31 23:59:59 UTC); W6 documentation |
| `a587352` | Spec 03 | Permission `requires:` lines on every story; O-6, OM-6, B-1..B-5 added; on_hold state machine clarifications |
| `0209f25` | Schema v3.1 | Explanatory comments on composite PK with nullable columns; sensitive maintenance contract |
| `8a9c971` | Schema v3.1 | Fix: missing `permissionEffectEnum` declaration and AUDIT_ENTITY_TYPES permission entries |
| `848487e` | Schema v3.1 | Two-tier RBAC additions: 5 new tables (`permissions`, `permission_groups`, `permission_group_members`, `role_permissions`, `user_permission_overrides`), `permissionEffectEnum`, audit entity types |
| `516ee8d` | Spec 04 LOCKED | Field mapping LOCKED; account-agnostic principles; per-account-config + post-pass-derivation patterns |
| `fd1f8ce` | Spec 04 | Account-agnostic mapping fixes (osorder→source, per-type duration, role override, primaryRole post-derivation) |
| `63d9b36` | Spec 04 DRAFT | Field mapping ISN to v3 with helpers signatures and cut list |

### Git tags

- `v3-schema-locked` — points at the v3 schema lock commit. Still valid; v3.1 and v3.1.1 are additive.

### Schema state at session end

- **Version:** v3.1.1, locked
- **Tables:** 32
- **Enums:** 18
- **PII markers:** 61
- **Soft-delete tables:** 7
- **Tables with direct `account_id`:** 8 (added `is_system` column to `users`; total tables with account_id unchanged at 8)
- **CHECK constraints:** 3 (`audit_log` entity_type, `role_permissions` exactly-one-target, `user_permission_overrides` exactly-one-target)

### Specs state at session end

| File | Status |
|---|---|
| `01-schema.ts` | v3.1.1 LOCKED |
| `01-schema-rationale.md` | LOCKED (RBAC architecture + migration design principles + bill-to-closing + Inspections conventions sections) |
| `03-user-stories.md` | LOCKED (30 stories + 7 Mermaid workflows + permission `requires:` lines + O-6, OM-6, B-1..B-5) |
| `04-field-mapping.md` | LOCKED |
| `05-migration-plan.draft.md` | DRAFT (Step 0 seeding expanded, Step 5.5 system user; lock pass after spec 02) |
| `06-security-spec.md` | UPDATED (S1-S11 complete; system user + implicit denies + PII masking subsections under S11) |
| `07-scalability-spec.md` | LOCKED (refreshed with v3 hot paths + cross-business customer query + read_sensitive multiplier) |
| `08-multi-business-extensibility-spec.md` | LOCKED (layered worked examples + organizations future expansion) |
| `shared/schemas/account-config.ts` | LOCKED (Zod for `accounts.config`) |
| `shared/schemas/business-config.ts` | LOCKED (Zod for `businesses.config`) |
| `shared/schemas/permissions-seed.ts` | LOCKED (50 permissions, 9 groups, 62 memberships, default role mappings, 29 implicit denies, 4 CI test helpers) |

---

## Model situation

### Correct model names in this OpenClaw deployment

| Name | Status | Context window |
|---|---|---|
| `anthropic/claude-opus-4-7` | ✅ ALLOWED | 1M tokens |
| `anthropic/claude-sonnet-4-6` | ✅ ALLOWED | 200k tokens |
| `claude-sonnet-4-5` | ❌ Rejected | (does not exist in this deployment) |
| `anthropic/claude-sonnet-4-5` | ❌ Rejected | (does not exist) |
| `anthropic/claude-sonnet-4-7` | ❌ Rejected | (does not exist) |

**The correct Sonnet name is `anthropic/claude-sonnet-4-6`, NOT `4-5`.** Earlier sessions wasted ~3 hours on Opus due to this typo.

### Context window discipline

- **Sonnet 4-6: 200k tokens.** Fresh sessions only. Anything over ~150k tokens of context will run hot.
- **Opus 4-7: 1M tokens.** Use for deep sessions or genuine architectural reasoning.

This session reached ~674k tokens. That's why we are stopping here. Tomorrow's session starts fresh.

### When to escalate to Opus during the building phase

Per Troy's earlier directive (2026-04-27 17:05 UTC):

- Edge cases during migration script writing where the answer affects production data integrity.
- Complex business logic in workflow diagrams where multi-step transitions need deeper reasoning.
- Moments where you find yourself uncertain about a real architectural call and want stronger judgment.

For spec 02 and spec 05, **stay on Sonnet by default.** Escalate to Opus only if a real architectural question surfaces. Switch back to Sonnet immediately after.

### Operational lesson: verify model after every switch

**Whenever a model-switch command (slash or tool parameter) returns an error, IMMEDIATELY pull `/status` to verify what is actually running.** Do NOT assume a failed switch reverted to a previous model or applied as expected.

This is captured in `TOOLS.md` and is non-negotiable going forward.

---

## Next deliverable: Spec 02 (API contract)

**File path:** `projects/isn-replacement/specs/02-api-contract.yaml` (locked to `02-api-contract.yaml` after review).

**Format:** OpenAPI 3.0 YAML.

**Scope:** Every endpoint required for the scheduling slice. Aligns with Express `/api/*` routing convention from the existing Replit project. References Drizzle types from `01-schema.ts`.

**Estimated effort:** ~4.5 hours of focused work.

**Endpoint coverage required (non-exhaustive checklist):**

- Auth: `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, MFA challenge endpoints
- Accounts and businesses: list, get, update (owner-scoped)
- Users: CRUD within business + invitation flow + status transitions
- User permissions admin: list, grant, revoke, view effective permissions
- Customers, properties, transaction participants, agencies: CRUD with scoping
- Junction maintenance: customer_businesses, property_businesses, agency_businesses
- Services catalog: CRUD per business
- Technician availability: hours, time-off, zips, service durations
- Inspections: CRUD, status transitions, reschedule, cancel, conflict detection
- Inspection participants and inspectors: junctions
- Inspection services: line items
- Slot finder: GET available slots
- Reports: list, download, release, override
- Audit log: query with filters
- Cross-business reports (owner-only): customers across businesses, etc.
- Health and metadata: build, time

---

## Pre-decisions for spec 02 already made

These are decisions made earlier in this session's chat history that Hatch should NOT re-litigate. Just apply them in the API contract.

### Authentication

- **Session-based, Passport.js with local strategy** (email + password).
- Sessions stored in Postgres via `connect-pg-simple`.
- Cookie attributes: `httpOnly: true`, `secure: true` in production, `sameSite: 'strict'`.
- Encrypted session payload at rest.
- Idle timeout: 24 hours default. Absolute timeout: 30 days. Both configurable per account via `accounts.config.session`.
- **MFA verification required for sensitive permission grants** when `accounts.config.security.requireMfaForPermissionGrants=true`.
- **No bearer tokens for human-facing API.** Sessions only.
- **The Passport authentication flow MUST reject any user with `is_system=true`**, regardless of credentials. Audit-logged with `outcome='denied'`.

### Error envelope

Standard JSON shape for all error responses:

```json
{
  "error": {
    "code": "permission_denied",
    "message": "Human-readable message",
    "details": {
      "required": ["manage.billing"],
      "missing": ["manage.billing"]
    },
    "requestId": "<uuid>"
  }
}
```

The `details` object is freeform; common keys per error code:
- `permission_denied`: `required[]`, `missing[]`
- `validation_failed`: `field_errors{}` keyed by field name with array of error messages
- `conflict`: `conflicting_field`, `existing_value`
- `not_found`: empty (no enumeration leak)

### HTTP status codes

| Code | Meaning |
|---|---|
| 200 | Success |
| 201 | Created |
| 204 | No content (deletes, etc.) |
| 400 | Validation failure (malformed request) |
| 401 | Unauthenticated |
| 403 | Forbidden (authenticated but lacks permission for an entity the user CAN see exists) |
| 404 | Not found OR cross-account hide OR no-permission hide |
| 409 | Conflict (unique constraint, optimistic concurrency) |
| 422 | Semantic validation failure (e.g., reschedule violates business hours) |
| 429 | Rate limited |
| 500 | Server error (with sanitized message) |

### Critical security pattern: 404 over 403 for cross-account or no-permission hides

Per S9 (account isolation):

- A user querying a record that exists but belongs to a different account: respond **404**. Do NOT reveal existence.
- A user querying a record they cannot see at all (even existence): respond **404**.
- A user querying a record that does not exist: respond **404**.
- A user querying a record they CAN see exists but lacks permission to act on: respond **403** with the permission_denied error envelope.

The 404-over-403 rule prevents account enumeration attacks. RLS at the DB layer means cross-account queries return zero rows, which the API layer translates to 404 naturally.

**Application rule:** if the user cannot see the entity exists at all (RLS hides it OR they lack `view.*` on its parent), respond 404. Only return 403 when they can see the entity exists but lack the permission for the specific action.

### Pagination

Per spec 07 Sc2 and Troy's directive (D2):

- **Cursor-based** on unbounded lists: `inspections`, `audit_log`, `email_logs`, `email_jobs`, `agreements`, `payment_events`, `automation_logs`, `communication_log`, `inspection_notes`, `customers`, `properties`, `transaction_participants`.
- **Offset/limit** explicitly NOT used in this API. Cursor only.

**Cursor format:** opaque base64-encoded `{ createdAt: ISO, id: UUID }`. Stable under concurrent inserts.

**Default page size:** 50. **Max:** 200.

**Pagination envelope:**

```json
{
  "data": [...],
  "pagination": {
    "nextCursor": "<base64>" | null,
    "hasMore": true | false,
    "pageSize": 50
  }
}
```

Query parameter: `?cursor=<base64>&pageSize=50`. Page sizes above 200 are clamped to 200 with a warning header.

### Permission references on endpoints

Every endpoint in spec 02 specifies its required permission(s) using a non-standard OpenAPI extension:

```yaml
x-required-permissions:
  all: ["edit.inspection.assign"]
```

Or for compound requirements:

```yaml
x-required-permissions:
  all: ["edit.inspection", "view.customer.pii"]
```

Or for "any of":

```yaml
x-required-permissions:
  any: ["manage.refund", "override.report_release_gate"]
```

The `x-required-permissions` extension is non-standard but useful for code generation and documentation. Convention documented in spec 02's intro.

### PII masking

Per S11 (PII masking pattern):

- API responses for routes returning customer/property PII apply masking based on the requesting user's effective permissions.
- Spec 02 documents the masked AND unmasked response shapes; the requesting user's permissions determine which they get.
- An `x-pii-fields` extension on response schemas marks which fields are subject to masking. Code generation uses this to apply the redaction helper consistently.

### `on_hold` inspection scheduledAt

- `inspections.scheduledAt` for `on_hold` rows is `9999-12-31 23:59:59 UTC` (the `ON_HOLD_PLACEHOLDER_AT` constant in `01-schema.ts`).
- API serialization MUST detect this sentinel and return it as `null` or a structured `"pending"` indicator, NOT the literal year-9999 string.
- Spec 02 documents this in the inspection response schema.

### Audit logging on every mutation

Every state-changing endpoint produces an `audit_log` row per S5 and the audit_log schema:

- `action` (one of `create | update | delete | view | release | override | reschedule | cancel | login | logout | read_sensitive | export`)
- `outcome` (`success | denied | failed | partial`)
- `entityType`, `entityId`
- `userId`, `accountId`, `businessId`
- `sessionId`, `requestId`
- `ipAddress`, `userAgent`
- `changes` jsonb (with `metadata.expanded_to` for permission grants per S11)

Spec 02 does not need to repeat this on every endpoint, but documents it once in the intro and references it.

### Cancellation and soft-delete distinction

Per platform issue #9 (ISN's overload of delete-as-cancel) and the v3 schema:

- **Cancellation:** sets `inspections.cancelledAt`, `cancelledBy`, `cancelReason`, `status='cancelled'`. Operational state. API endpoint: `POST /api/inspections/{id}/cancel`.
- **Soft-delete:** sets `inspections.deletedAt`, `deletedBy`, `deleteReason`. Administrative removal. API endpoint: `DELETE /api/inspections/{id}` (with mandatory body containing `reason`).

These are distinct operations with distinct permissions (`cancel.inspection` vs `delete.inspection`).

---

## Open questions still pending (for spec 02 to flag, not resolve)

These were captured in earlier specs; carrying forward for visibility. Spec 02 marks affected endpoints with `x-status: future` or `x-status: deferred` extensions where appropriate.

1. **Realtor portal authentication.** No portal login model defined. Spec 02 documents future endpoints as `x-status: future`; auth design is a separate slice.
2. **Client portal authentication.** Same as realtor portal.
3. **WebSocket vs polling for dispatcher dashboard.** Spec 02 documents REST-over-poll today; WebSocket spec is separate when implemented.
4. **Drive-time integration provider.** Out of scope for spec 02; surfaces as static drive-time hints in the inspector daily view response.
5. **Slot algorithm cache backend.** Out of scope for the API contract; implementation detail for the slot service.
6. **Bulk operations rate limits.** Spec 02 documents rate-limit headers (`X-RateLimit-*`) but defers specific limits to operational tuning.
7. **No-show fee policy storage.** Defers to per-business config.
8. **Account-level dashboard cross-business UNION strategy.** Spec 02 documents the endpoint shape; query strategy is implementation detail.
9. **Custom fields UI surfacing rules.** Spec 02 returns the raw `customFields` jsonb; UI rendering rules are not API-layer concerns.
10. **Field-level encryption strategy (S3).** Deferred. Spec 02 documents the masking pattern (S11) which is what we use today.
11. **Bookkeeper Owner-notification threshold for permission grants** (OM-6 acceptance criteria). Default per implementation: configurable per account, starting value of 10 grants/week or 1 sensitive grant immediately.

---

## Tomorrow's startup procedure

### Step 1: Open a fresh OpenClaw session

Do NOT continue this session. The context size (~674k tokens) exceeds Sonnet's 200k limit.

### Step 2: Switch model to Sonnet

```
/model anthropic/claude-sonnet-4-6
```

**Then immediately verify with `/status`.** If the switch failed, the status output will show Opus or another model, not Sonnet. Do not proceed until `/status` confirms `anthropic/claude-sonnet-4-6`.

### Step 3: Tell Hatch to read the handoff and locked specs

Single instruction:

> "Read `projects/isn-replacement/handoff.md` then proceed with spec 02."

Hatch reads the handoff plus the locked specs in this order:

1. `projects/isn-replacement/handoff.md` (this file)
2. `projects/isn-replacement/specs/01-schema.ts` (v3.1.1 schema, source of truth for entity shapes)
3. `projects/isn-replacement/specs/03-user-stories.md` (the stories that drive endpoint design)
4. `projects/isn-replacement/specs/04-field-mapping.md` (ISN→v3 mapping; relevant for migration-related endpoints)
5. `projects/isn-replacement/specs/06-security-spec.md` (auth, RLS, S9, S10, S11 all relevant)
6. `projects/isn-replacement/specs/07-scalability-spec.md` (pagination strategy Sc2; hot-path queries Sc5)
7. `projects/isn-replacement/specs/shared/schemas/permissions-seed.ts` (the 50 permissions referenced by every endpoint)

The existing Replit project's `server/routes.ts` is in `projects/isn-replacement/replit-snapshot/` (gitignored locally) and shows the current API surface that spec 02 evolves from. Reference for naming conventions and route structure.

### Step 4: Spec 02 work begins

Hatch drafts spec 02. Pause at completion for Troy's review before locking.

---

## Building phase remaining work

| Deliverable | Estimated effort |
|---|---|
| Spec 02 (API contract) | ~4.5 hours |
| Spec 05 (migration plan lock pass) | ~3.25 hours |
| Migration scripts in `specs/migration/` | ~8.5 hours |
| **Total remaining** | **~16 hours** |

### Process notes

- **Pause at completion of each deliverable** for Troy's review before locking.
- **404-over-403 hide pattern** is the most subtle security rule in the API contract. Get it right.
- **Verify model status after every switch.** Non-negotiable per the operational lesson captured in `TOOLS.md`.
- **Stay on Sonnet by default.** Escalate to Opus only for genuine architectural questions during spec 02 or spec 05.
- **Migration script implementation may surface real architectural calls** (e.g., handling ISN's stub-vs-detail pattern, dedupe edge cases). Escalate to Opus if data integrity is at stake.

---

## What NOT to do tomorrow

- Do not re-litigate the architectural decisions captured in this handoff or in the locked specs.
- Do not skip the handoff read. The session context is gone; the locked specs are the only source of truth.
- Do not use offset pagination anywhere in spec 02. Cursor only, per the pre-decision above.
- Do not switch to Opus for spec writing unless a real architectural question surfaces.
- Do not introduce new permissions or groups in spec 02. The 50 permissions in `permissions-seed.ts` are the locked catalog. New permissions go through a separate decision and migration cycle.
