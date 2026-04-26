# Existing Replit Project State, isn-killer

_Reviewed 2026-04-26 from snapshot tarball at `replit-snapshot/`. Source is Troy's running Replit project. This file captures what already exists so specs align rather than design in a vacuum._

## Stack confirmation, vs `target-stack.md`

The snapshot matches the stated stack with one notable correction:

| Layer | Stated | Confirmed in snapshot |
|---|---|---|
| Backend framework | Express.js | Express **5.0.1** |
| ORM | Drizzle | `drizzle-orm@0.39.3` + `drizzle-kit@0.31.8`, `drizzle-zod@0.7.0` |
| Database | Postgres (Neon via Replit) | Postgres confirmed, but driver is **`pg` (node-postgres)**, not Neon's serverless driver. Connection in `server/db.ts` uses standard `Pool`. |
| Auth | Passport local + sessions | Confirmed. `passport@0.7.0`, `passport-local`, `express-session`, `connect-pg-simple@10`. Password hashing is **scrypt + 16-byte random salt, format `<hex-hash>.<hex-salt>`**. |
| Email | Resend | `resend@6.9.4` installed. |
| Templates | Handlebars | `handlebars@4.7.8` installed. |
| Frontend | React, Vite, Wouter, TanStack Query v5, shadcn/ui, Tailwind, RHF + Zod | All present. React 18.3, Vite 7.3, Wouter 3.3, TanStack Query 5.60, RHF 7.55, Zod 3.24. shadcn/ui via Radix primitives, ~40 components installed. |

**Single deviation worth noting:** the project uses standard `node-postgres` against `DATABASE_URL`. It is not yet on Neon's serverless WebSocket driver. Spec should mirror this or call out the migration explicitly.

## Project structure

```
client/                React + Vite app (root for Vite is client/)
  src/
    pages/             Top-level routes (15 pages)
    components/ui/     shadcn primitives
    components/        App-specific components (sidebar, theme)
    hooks/             Including use-auth.tsx (AuthProvider context)
    lib/               queryClient, etc.
server/                Single Express process
  index.ts             Entry, wires auth, blockViewerWrites, routes, vite or static
  routes.ts            Monolithic, ~1500 lines, mounts /api/* routes inline
  routes/              Modular email routes (separate from routes.ts)
  auth.ts              Passport + scrypt + connect-pg-simple wiring
  db.ts                Drizzle pool (`pg.Pool`)
  storage.ts           Data access layer, IStorage interface, ~98 methods
  audit.ts             Audit logging helper
  access-evaluator.ts  Report-release gate logic (paid + signed + uploaded)
  automation.ts        Automation rule engine, time-based scheduler
  file-storage.ts      Local uploads/ with UUID keys, path-traversal safe
  seed.ts              Seed real team from FEATURES.md
  vite.ts / static.ts  Dev vs prod asset serving
  lib/email/           Modular email engine (renderer, recipients, queue, dedupe, conditions, provider, trigger-engine, merge-fields)
  lib/scheduling/      Scheduling event system (events.ts, appointment-service.ts)
  workers/             Background workers (process-email-jobs.ts)
  types/               Backend-only types (appointment, email)
shared/
  schema.ts            Drizzle pgTable definitions, Zod insert schemas, TS types (single file, 636 lines)
scripts/               One-off TS scripts (create-ai-user, create-viewer-user)
script/                build.ts (note: singular, separate from scripts/)
attached_assets/       Reference materials, including TASKS.md and a deep research report
uploads/               File storage root (for inspections)
drizzle.config.ts      Schema at ./shared/schema.ts, output ./migrations
.replit                Run = npm run dev, port 5000 -> 80, deploys to autoscale
```

Path aliases (`tsconfig.json` and `vite.config.ts`):

- `@/*` → `client/src/*`
- `@shared/*` → `shared/*`
- `@assets/*` → `attached_assets/*`

TypeScript is **strict** (matches the format requirement).

## Database schema, what already exists

`shared/schema.ts` defines **25 tables** today:

| Table | Purpose | Notable |
|---|---|---|
| `users` | Internal team only | `role` is a single `varchar(50)`. Roles: `owner`, `operations_manager`, `inspector`, `client_success`, `viewer`. Has `passwordHash`, `status`. **Does NOT model overlapping ISN-style roles.** |
| `contacts` | Clients and agents | `type` discriminator (`client`, `buyer_agent`, `listing_agent`, `transaction_coordinator`). |
| `inspections` | Core scheduling entity (renamed from "orders") | UUID PK. Has separate `scheduledDate (date)` and `scheduledTime (time)` columns, plus `durationMinutes (default 120)`. Multi-axis status: `status`, `paymentStatus`, `signatureStatus`, `qaStatus`, plus `reportReleased` boolean. Has `tcName/Email/Phone` inline. References `users` for inspector, `contacts` for client/buyer agent/listing agent. |
| `reschedule_history` | Audit of reschedules | Tracks previous and new date/time/inspector, `reason`, `initiatedBy`. |
| `files` | Per-inspection uploads | Soft delete via `deleted` boolean. UUID storage keys. |
| `agreement_templates` | E-sig HTML templates | |
| `agreements` | Sent agreements | Token-based public signing, SHA-256 doc hash, IP/UA capture. |
| `payment_events` | Payment transaction log | Event types: initiated/completed/failed/refunded/manual. |
| `automation_rules` | Configurable triggers | |
| `automation_queue` | Scheduled actions | |
| `automation_logs` | Execution log | |
| `audit_log` | Full audit trail | userId, action, entityType, entityId, changes JSON, ipAddress |
| `company_settings` | Single-row company config | |
| `services` | Service catalog | `baseFee` decimal(10,2). **Is the new system's analog of ISN ordertypes.** |
| `email_templates` | Email templates | versioned, status (draft/active/archived), templateType taxonomy |
| `email_template_assignments` | Template ↔ event linkage | sendMode, sendTimingType, delayMinutes, scope filters |
| `email_template_conditions` | Conditional rules per assignment | operator-based, group OR semantics |
| `email_jobs` | Queued sends | with dedupe key, retry counts |
| `email_logs` | Immutable send history | |
| `email_provider_events` | Webhook payloads | |
| `sms_templates` | SMS templates | |
| `integrations_config` | Third-party config | Stripe, SendGrid, Twilio, Zoho, Google Calendar |
| `inspection_services` | Many-to-many inspections ↔ services | |
| `inspection_notes` | Activity log per inspection | system vs manual |
| `communication_log` | Per-inspection comm history | |

The `session` table is managed by `connect-pg-simple` outside of Drizzle.

**TypeScript types and Zod insert schemas are exported alongside each table** (`User`/`InsertUser`, etc.). Format requirement is already in place.

## API surface, what already exists

`server/routes.ts` mounts roughly **80+ endpoints** under `/api/*`. Auth is applied via `app.use("/api/...", requireAuth)` blocks. Viewers are blocked from writes via `blockViewerWrites` middleware on `/api/*`.

Coverage by domain:

- **Auth:** login, logout, me (in `auth.ts`).
- **Users:** full CRUD plus `users/role/:role`.
- **Contacts:** full CRUD plus `contacts/type/:type` and `contacts/search`.
- **Inspections:** full CRUD, plus stats, conflicts, status filter, inspector filter, files, access-status, reschedule, cancel, release, release-override, reschedule history.
- **Files:** download, soft delete.
- **Audit log:** read with filters.
- **Settings:** company.
- **Services:** full CRUD.
- **Email:** templates CRUD, assignments CRUD, conditions, jobs queue, logs, provider events, three webhook receivers (Resend, SendGrid, Postmark), preview, manual send-from-inspection.
- **SMS:** templates CRUD.
- **Integrations:** config read, patch.
- **Inspection services / notes / communications:** nested under inspections.
- **Agreement templates and agreements:** including public signing endpoints.
- **Automation:** rules CRUD, queue read/patch.

Pagination and `after` filters are not present on bulk lists. The existing API returns full collections in one shot. **For ISN-scale data this will need pagination before cutover.**

## Frontend pages, what already exists

15 top-level pages, mounted in `client/src/App.tsx` with Wouter:

- `/` Dashboard
- `/inspections`, `/inspections/new`, `/inspections/:id`, `/inspections/:id/edit`
- `/contacts`
- `/team`, `/team/new`, `/team/:id`, `/team/:id/edit`
- `/calendar` (month/week/day/agenda views per replit.md)
- `/dispatch` (drag-and-drop dispatch board)
- `/sign/:token` (public agreement signing)
- `/settings/company|services|email-templates|sms-templates|notifications|integrations|users|agreement-templates|automations`
- `/login`, `*` (NotFound)

Sidebar layout, theme toggle, auth gate are in `App.tsx`. Auth context is `useAuth` from `client/src/hooks/use-auth.tsx`.

## Key behaviors already implemented

Per `FEATURES.md` and `replit.md`, these are reportedly working:

- Passport login, session cookies, role gating, viewer write block.
- Inspection CRUD with auto order numbers `SH-YYYY-NNNN`.
- Inspector conflict detection (overlapping appointments same date/time).
- Multi-status inspection model (5 axes).
- Reschedule and cancel workflows with required reasons, history table, automation re-trigger.
- Calendar with 4 view modes plus filters and color-by toggle.
- Dispatch board with drag-and-drop and conflict on drop.
- Reports gated until paid + signed + uploaded, with admin override and audit.
- Files with soft delete, path-traversal guard, UUID keys.
- E-signature: token-based public signing, SHA-256 doc hash, IP/UA capture, ESIGN certificate.
- Audit log on every CRUD.
- Communication log per inspection with hold/cancel.
- Email engine: render, recipient resolution, conditions, dedupe, queue, provider abstraction, three webhook handlers, background worker.
- Automation engine with 9 trigger events and 5-minute queue tick.

This is **substantial.** A meaningful portion of the scheduling slice is already standing.

## Gaps relative to the ISN replacement scope

Things ISN does that this project does not yet model:

1. **Inspector territory / ZIPs.** No table or columns for inspector ZIP coverage. ISN has it (we saw 72 ZIPs on Troy's user). Needs adding for territory-based assignment.
2. **Inspector working hours / availability windows.** No availability or schedule-template table. ISN has working hours and time-off, even if loosely. Required for slot computation.
3. **Drive-time / buffer between inspections.** Not modeled. Conflict detection is "same date/time only," not "within drive-time." This is one of ISN's documented weaknesses we want to beat.
4. **`/availableslots`-style endpoint.** No public or office-side "give me available slots for inspector X" API. The current "conflict check" endpoint only confirms an already-chosen time is free.
5. **Realtor portal.** Pages exist for internal staff. There is no agent-partner login, no agent-scoped views, no agent self-book flow.
6. **Client booking flow.** No client-facing scheduling page (booking widget). Schedules are dispatcher-driven.
7. **Multi-office support.** Single `companySettings` row implies single-office. ISN scopes order types to office. We are single-office today, but the schema should leave a clean path.
8. **Service durations per inspector.** `services` table has `baseFee` but no `defaultDurationMinutes`. Inspections carry `durationMinutes` directly. For the rebuild slot algorithm we need duration on the service or a join.
9. **Agencies / brokerages.** No `agencies` table. ISN has agencies with `~9000` agents tied to them. We model agent as a contact with optional `company` text. For dispatcher productivity (filtering by brokerage, sending bulk realtor comms), we likely want a real `agencies` table.
10. **Pagination on bulk lists.** Will be required at production scale.
11. **`/api/calendar/availableslots`** endpoint. Not present.
12. **Inspector role overlap.** Current `users.role` is a single varchar. Some staff may be inspector + dispatcher + manager simultaneously. Needs revisit when we decide the role model.

## What this means for the build-ready specs

When I produce `01-schema.ts`, the schema spec will be **a delta and extension on what exists**, not a from-scratch design. Concretely:

- **Reuse:** `users`, `contacts`, `inspections` (mostly), `reschedule_history`, `files`, `services`, automation/email/audit/settings tables.
- **Extend `users`** with: ZIP coverage (junction or array), working hours, role-overlap support (junction), service-area polygons (later).
- **Extend `services`** with: `defaultDurationMinutes`, optional per-inspector overrides.
- **Add tables:** `agencies`, `inspector_availability` (recurring rules), `inspector_time_off`, `inspector_zip_coverage` (or column array), maybe `inspector_service_durations` for per-inspector overrides.
- **Add API routes:** `GET /api/calendar/availableslots`, agencies CRUD, agent self-booking endpoints (later), realtor portal endpoints (later slice).
- **Note pagination as a cross-cutting requirement.**
- **Keep field names the snapshot already uses** to avoid breaking existing code. Where ISN fields differ, the field mapping doc captures the mapping.

## File hygiene observations on the snapshot

- `attached_assets/Employees_1772118621410.xlsx` may contain real PII (employee data). Already inside the snapshot directory which is gitignored at the project root, but worth flagging.
- The snapshot tarball was kept inside `replit-snapshot/`. Will move it to a sibling location and gitignore it.
- The `.local/skills/` folder inside the snapshot is Replit Agent skill metadata, irrelevant for our review.

## Open questions for Troy

1. **Are you planning to keep the existing `users.role` single-value model, or expand to overlap?** Depends on whether dispatchers ever wear an inspector hat in practice.
2. **Pagination strategy.** Cursor-based (the modern default) or offset/limit (simpler, fine for this scale)?
3. **Are `attached_assets/`, `uploads/`, and `Employees_*.xlsx`** OK to keep inside the snapshot folder under workspace gitignore, or should I move/redact them now?
4. **Is the existing `inspections` table's split of `scheduledDate (date) + scheduledTime (time)` a deliberate design, or do you want me to recommend a single `scheduled_at timestamptz` in the schema spec?** The split avoids timezone bugs but creates more null surfaces. I have a recommendation, but you should weigh in.

## Action items I am queuing for myself

- Move snapshot tarball out of the unpacked tree (don't double-store).
- Confirm `replit-snapshot/` is gitignored (it lives under `projects/isn-replacement/`, parent already ignores `discovery/raw/` and `discovery/csv/`, but not `replit-snapshot/`). Add it.
- Reference this file from every spec under `projects/isn-replacement/specs/`.
