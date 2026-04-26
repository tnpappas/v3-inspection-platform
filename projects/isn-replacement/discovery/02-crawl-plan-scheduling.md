# ISN Read-Only Crawl Plan, Scheduling Slice

_Drafted 2026-04-25. Awaiting Troy's approval before any data calls run._

## Ground rules

- **Read-only.** Only `GET` requests. No `POST`, `PUT`, `PATCH`, `DELETE` under any circumstance.
- **No footprint deletion.** ISN's docs say to delete footprints after read. We will not. Operational impact: footprints linger until ISN auto-purges. Acceptable.
- **Local artifact storage.** Raw responses saved under `projects/isn-replacement/discovery/raw/` for inspection and replay. PII will live in this folder, **the folder will be gitignored** so credentials and client data never enter version control.
- **Throttle.** Inject ~250ms between calls and ~1s between phases. ISN is on Cloudflare, no advertised rate limit, but we are crawling a vendor that already dislikes us. No reason to be rude.
- **Pagination unknowns.** ISN's spec does not document offset/limit on `/orders`, `/agents`, `/clients`. The `after` query param appears to be the supported pattern (modified-after timestamp). Plan accommodates this.
- **Errors logged.** Every non-`status:ok` response saved with the request that produced it.

## Phase 0, Smoke test (4 calls, ~1 second)

Goal: confirm auth and identify the authenticated user.

| # | Call | Why |
|---|---|---|
| 0.1 | `GET /me` | Confirms which user the keys map to and what permissions/role they have. |
| 0.2 | `GET /companykey` | Sanity check that the company slug from the API matches `safehouse`. |
| 0.3 | `GET /build` | ISN build number, useful for spec-vs-prod drift detection. |
| 0.4 | `GET /time` | Server time, useful for interpreting timestamps. |

**Stop and review with Troy after Phase 0.**

## Phase 1, Reference data (5 calls, ~2 seconds)

Goal: pull the small lookup tables that other entities reference.

| # | Call | Why |
|---|---|---|
| 1.1 | `GET /offices` | Office list. Inspectors are scoped to offices. |
| 1.2 | `GET /users` | All ISN users. Inspectors, dispatchers, owners. Inspector identity sits here. |
| 1.3 | `GET /ordertypes/` | Inspection types offered (home, radon, sewer scope, etc.). Required for slot lookups. |
| 1.4 | `GET /contacttypes/` | Contact role taxonomy. Cheap, useful. |
| 1.5 | `GET /agents` | Real estate agents. Used as foreign keys on orders. |

**Stop and review.** From `/users` we extract inspector UUIDs needed for Phase 3.

## Phase 2, Orders snapshot (variable, biggest unknown)

Goal: pull the schedule itself. Modified-after windowing keeps it incremental and avoids monster responses.

| # | Call | Why |
|---|---|---|
| 2.1 | `GET /orders?completed=false&after=<90 days ago>` | Open/upcoming work. The active schedule. |
| 2.2 | `GET /orders?completed=true&after=<30 days ago>` | Recently completed inspections. Anchors patterns: durations, fees, agent associations. |
| 2.3 | `GET /orders/footprints?all=true` | Cross-inspector "upcoming hooks." The `all=true` flag is owner-permission only, which Troy has. |

Then, for **each order returned in 2.1 and 2.2**, sample a representative subset for full detail:

| # | Call | Why |
|---|---|---|
| 2.4 | `GET /order/{id}?withallcontrols=true&withpropertyphoto=false` | The complete order shape, including all custom fields. We need the full field surface, not the summary. |
| 2.5 | `GET /order/fees/{id}` | Line-item fees. Critical for the $40-vs-$100 margin question. |
| 2.6 | `GET /order/history/{id}` | Status-change history. This is the audit trail and a major signal for the dispatch model. |

**Sampling, not a full crawl.** First pass: fetch full detail on the first 25 orders from each list (so 100 detail bundles total, plus fees and history each). Stop. Review the data shape. Then decide if full extraction is justified, and how to chunk it.

## Phase 3, Availability and slot logic

Goal: understand how ISN computes "available slots." This is the core algorithm we have to replace.

| # | Call | Why |
|---|---|---|
| 3.1 | `GET /availableslots?inspector=<uuid>&daysahead=14&offset=0` | Default forward window for one inspector. Repeat for 2-3 inspectors. |
| 3.2 | `GET /availableslots?inspector=<uuid>&daysahead=14&offset=0&services=<typeId>` | Same query with a service filter. Tells us if availability changes per service type, which implies durations are per-service. |
| 3.3 | `GET /availableslots?inspector=<uuid>&daysahead=14&offset=0&zip=23456` | With a zip filter. Tells us if drive-time/territory affects ISN's slotting (per your input it does not auto-enforce, but the API may model it). |
| 3.4 | `GET /calendar/availableslots?...` (same args) | Spec lists both endpoints. Compare to confirm they are aliases or differ. |

Hypothesis going in: ISN's slot computation = inspector working hours minus booked orders, with optional service-type duration. Drive time appears to be uninvolved. We will confirm or break that hypothesis from the data.

## Phase 4, Clients (last, smallest priority for scheduling)

| # | Call | Why |
|---|---|---|
| 4.1 | `GET /clients?after=<30 days ago>` | Recent clients. Just to capture the client model shape, not for full extraction. |
| 4.2 | `GET /client/{id}` on a sample of 5 | Full field shape. |

## Outputs of the crawl

Saved to `projects/isn-replacement/discovery/raw/<phase>/<endpoint>-<timestamp>.json`. From those, I will produce:

1. **`schema-isn.md`** — extracted entities and fields actually in use, normalized.
2. **`workflow-scheduling.md`** — the "how a job goes from request to scheduled to dispatched" picture, derived from `/order/history/{id}` traces.
3. **`slot-algorithm.md`** — reverse-engineered availability logic.
4. **`field-coverage.csv`** — every field on every entity, with frequency of population in real data. Helps us spot which fields are vestigial and which are load-bearing.

## What I will NOT crawl in this slice

- Agreements, payments, reports, realtor portal data. Those are later slices.
- Insurance agents, escrow officers, escrow offices, agencies. Not needed for scheduling.
- Any write endpoints. Period.

## Estimated total request count for full Phase 0-4

- Phase 0: 4
- Phase 1: 5
- Phase 2: ~3 list calls + ~50 detail bundles × 3 calls each = ~150
- Phase 3: ~12
- Phase 4: ~7
- **Total: ~180 GET requests, all read-only.**

## Open dependencies on Troy

1. **Approve this plan** before any data is pulled.
2. Confirm whether you want me to also store **CSV exports** from the ISN UI in parallel (`projects/isn-replacement/discovery/csv/`) for cross-checking the API. CSV often surfaces fields the API hides.
3. Confirm the report writing tool (HomeGauge / Spectora / Horizon / other). Out of scope for this slice but I want it on the file before the screen-share.
