# MEMORY.md - Hatch's long-term memory

_Last updated: 2026-04-28_

## Identity

- **Name:** Hatch
- **Role:** Executive assistant and operations partner to Troy
- **Style:** Direct, businesslike, dry. No flattery, no em dashes, no filler.
- **Scope:** Four businesses (Safe House Property Inspections, Pest Heroes, HCJ Pool Services, My Driven Threads)

## Troy

- **Name:** Troy Pappas
- **Location:** Virginia Beach, VA (America/New_York)
- **Reachable:** Web chat + Telegram
- **Wants:** Truth, not comfort. Push back when warranted. Rank options by benefit.

## ISN Replacement Project (Safe House)

### Status as of 2026-04-28: Foundation + Building phases COMPLETE

**Git tags:**
- `v3-schema-locked` — schema v3 approved 2026-04-27
- `v3-building-phase-complete` — building phase approved 2026-04-28

**All artifacts locked at** `projects/isn-replacement/`:

| Artifact | Status |
|---|---|
| Schema v3.1.2 (32 tables, 18 enums, 61 PII markers) | LOCKED |
| Spec 02 — API contract (OpenAPI 3.0, 69 endpoints) | LOCKED |
| Spec 03 — User stories (30 stories, 7 Mermaid diagrams) | LOCKED |
| Spec 04 — Field mapping (ISN → v3, 14 helpers) | LOCKED |
| Spec 05 — Migration plan (8 steps, fully idempotent) | LOCKED |
| Specs 06/07/08 — Security / Scalability / Extensibility | LOCKED |
| 11 migration scripts in specs/migration/ | COMPLETE |
| migration-prep-checklist.md (6 open questions + go-live) | COMPLETE |

**Next phase: Implementation**
1. Apply v3.1.2 schema to `isn-killer` Replit project.
2. Wire 69 API endpoints from spec 02 using existing Express/Passport stack.
3. Work through `specs/migration-prep-checklist.md` against staging.
4. Parallel-run v3 alongside ISN for 1 week, then cut over.
5. Saves >$12K/year; Safe House owns its data.

### Key technical decisions locked

- **Pattern B + accounts:** multi-tenant (account → businesses → shared customers/properties)
- **Schema:** v3.1.2, 32 tables, Drizzle ORM, Postgres (Neon via Replit)
- **RBAC:** Two-tier (50 granular permissions + 9 groups); per-business roles; per-user overrides with expiry
- **Auth:** Passport.js sessions, session-cookie only, MFA required for owners
- **Pagination:** cursor-based on all unbounded lists, default 50 / max 200
- **Order numbers:** per-business Postgres sequence, format `SH-YYYY-NNNNNN`
- **on_hold placeholder:** `9999-12-31 23:59:59 UTC` (`ON_HOLD_PLACEHOLDER_AT`)
- **ISN cancel = delete:** `deleteddatetime` → `cancelledAt` (platform issue #9)
- **Migration:** idempotent upserts via `isnSourceId`; dedup keys for properties/customers; 6-month cancellation cutoff

### ISN API findings (9 platform issues catalogued)

ISN costs $12K+/year, raises fees, ignores requests, is owned by a data-hungry parent corp. Found 9 API hygiene failures in discovery:

1. Published OpenAPI spec has broken server URL (.com instead of .net)
2. Published spec lags production by 153 builds
3. Duplicate slot endpoints
4. Path params documented as query params
5. Spec lags live by 153 builds
6. Bulk endpoints return undocumented stubs
7. Production fields not in spec
8. `after=` filter silently ignored (61,387 orders returned when 800 expected)
9. No first-class cancellation; "cancel" = soft-delete via `deleteddatetime`

## Model / operational notes

- **Sonnet:** `anthropic/claude-sonnet-4-6` (1M context window in this deployment)
- **Opus:** `anthropic/claude-opus-4-7` (1M context window, default)
- **Rule:** Always verify model with `/status` after any `/model` switch attempt. Do not assume a failed switch reverted cleanly.
- **Rule:** Confirm intent on 6 is `user_preferences`, not `user_businesses` for is_primary.

## Businesses

1. **Safe House Property Inspections** — ISN replacement in progress
2. **Pest Heroes** — pest control, currently on FieldRoutes
3. **HCJ Pool Services** — pool service, currently on Skimmer
4. **My Driven Threads** — apparel, 250 Collection launch June 2026, stays on Shopify

## Background context

- Austin McCrory transitioning to full leadership at Safe House
- Safe House profit per ticket $40 vs $100+ target
- Florida pool enclosure construction dispute (HCJ-related)
