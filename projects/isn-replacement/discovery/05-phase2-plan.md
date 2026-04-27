# Phase 2 Plan, Orders Crawl

_Drafted 2026-04-26. Block A executed 2026-04-26 21:15 UTC. Block B and Block C **paused** pending review and architecture-update aware re-plan._

## Status update, 2026-04-26 21:48 UTC

**Block A complete.** Findings logged in `06-phase2-block-a-findings.md` (separate file). Headlines:

- `/orders` returned stubs (id/show/modified), same pattern as `/agents`. Total of **61,387 orders** in the lifetime list (37,032 open + 24,355 completed).
- ISN's `after=` filter appears to be **ignored** on `/orders`. Documented as platform issue #8.
- `/orders/footprints?all=true` returned an empty array, not a useful cross-inspector view.
- Stub records cannot be stratified directly. Sampling needs detail calls first.

**Architecture pivot, also 2026-04-26 21:48 UTC.** Multi-business Pattern B accepted. The Phase 2 results doc, when written, must map ISN's order/client/agent shapes into the new multi-business schema (`specs/01-schema.ts` v2), specifically:

- ISN `client` -> `customers` (shared, no business_id) + `customer_businesses[business=safehouse]`
- ISN `agent` -> `transaction_participants` (shared) + `inspection_participants` rows on the relevant inspections
- ISN `order` property fields -> `properties` (shared) + `property_businesses[business=safehouse]`
- ISN `order` -> `inspections (business_id=safehouse)`
- ISN `inspector` (a user) -> `users` + `user_businesses[business=safehouse]` + `user_roles[user, business=safehouse, role=technician]`

No new ISN calls are needed for the architecture pivot. The same data, mapped differently.

## Goal

Capture the orders/inspections data model in enough fidelity to inform `01-schema.ts` and `04-field-mapping.md`. Sample, not scrape.

## Total call count

**~50 GET requests, all read-only.** Down from the original ~150 estimate after Phase 1 confirmed bulk endpoints return stubs.

| Block | Calls | Notes |
|---|---|---|
| Block A: list endpoints | 3 | All-orders snapshots and footprints |
| Block B: stratified order detail | 30 | 25 from completed + 5 from open, stratified by type/inspector/recency |
| Block C: deep detail on a tight subset | 20 | 10 fees, 10 history, on the 10 most-informative orders |
| **Total** | **~53** | |

Throttle: 400ms between calls (slightly more conservative than Phase 1 since each call costs ISN more compute).

## Block A: list endpoints

| # | Call | Purpose | Expected response |
|---|---|---|---|
| 2.1 | `GET /orders?completed=false&after=<2026-01-26 ISO>` (90-day open window) | Active and upcoming inspections | Likely **stubs** (id, show, modified). Returns the population we will sample from. |
| 2.2 | `GET /orders?completed=true&after=<2026-03-26 ISO>` (30-day completed window) | Recent completed inspections | Likely stubs. Source for completed-side stratification. |
| 2.3 | `GET /orders/footprints?all=true` | Cross-inspector "upcoming hooks" view (owner-only flag) | Returns lightweight order references. Confirms which inspectors are dispatched and what sits in their queues. |

**Hypothesis to validate:** `/orders` returns stubs like `/agents` did. If it returns full records, we revise downstream blocks (we likely don't need 30 detail calls then). Decision point built into the run.

## Block B: stratified order detail

Pulled only after A confirms the population.

### Stratification rules

From the union of 2.1 + 2.2, pick **30 orders** that satisfy ALL of:

- At least **1 from each of the last 3 calendar months** (currency).
- At least **3 distinct inspectors** represented.
- At least **3 distinct order types** represented.
- At least **5 completed** + at least **5 open**.
- At least **2 with `signatureStatus`-like flags showing signed**, at least **2 unsigned** (if visible from stub list, otherwise sampled blind).
- At least **2 with multi-inspector orders** (large commercial, per Troy) IF any exist in the window. If none exist in the 90-day window, note the absence and skip.

Selection is **deterministic from the stub list** (sort by `modified` desc within each stratum, take the head). If a target stratum is empty, that fact is itself a finding worth recording. The sampling script saves the picked IDs to `discovery/raw/phase2/sample-ids.json` so the exact selection is auditable.

### Calls per selected order

| Call | Purpose |
|---|---|
| `GET /order/{id}?withallcontrols=true&withpropertyphoto=false` | Full order shape, custom fields, all controls. **Skips photo to keep payloads lean.** |

Block B = 30 detail calls.

## Block C: deep detail on a 10-order subset

From Block B's 30, take the **10 most-informative** orders (the ones with the most populated fields, most distinct service types, and the longest history). For each:

| Call | Purpose |
|---|---|
| `GET /order/fees/{id}` | Line-item fees. Critical for the $40-vs-$100 margin analysis. |
| `GET /order/history/{id}` | Status-change audit trail. Reveals dispatch timing and reschedule patterns. |

Block C = 20 calls.

## What we will NOT call in Phase 2

- `GET /order/webdelivery/{id}` (report URL endpoint). Out of scope for the scheduling slice. Captured later when we tackle report delivery.
- Any clients endpoint. That is Phase 4.
- Any agent detail beyond what a single order references. Mass agent crawl is a separate, throttled batch outside this discovery work.
- Any availability slot calls. That is Phase 3.
- **Zero write endpoints**, ever.

## PII handling plan

This is the first phase that pulls client names, addresses, emails, and phones. Treatment:

1. **Storage location:** `discovery/raw/phase2/` only. This path is gitignored (verified, both `discovery/raw/` and `discovery/csv/` are in `projects/isn-replacement/.gitignore`).
2. **No PII in committed files.** `04-field-mapping.md`, `01-schema.ts`, the eventual results doc (`06-phase2-results.md`), and any other tracked artifact must use **redacted examples or synthetic placeholders**, never real names/addresses pulled from raw responses.
3. **Redaction in chat replies.** When summarizing for Troy, I will redact UUIDs (already doing this), client names/emails/phones/addresses by default. If Troy needs a specific real example, he asks.
4. **Local file mode.** Raw files written with default umask (`0644`). They sit inside the user's workspace which is not exposed externally. Acceptable for this environment. If we later move this work to a shared location, we tighten to 600.
5. **Retention.** Raw responses are kept until the schema spec is locked, then archived or scrubbed. Decision in the migration plan, not now.
6. **No exfiltration.** I will not paste raw response bodies to external services (web fetches, search, etc.) at any point.

## Output artifacts

After Phase 2 runs:

- `discovery/raw/phase2/list-completed-<ts>.json`
- `discovery/raw/phase2/list-open-<ts>.json`
- `discovery/raw/phase2/footprints-<ts>.json`
- `discovery/raw/phase2/sample-ids.json` (the deterministic 30-order selection)
- `discovery/raw/phase2/order-{redacted-id}-<ts>.json` x30
- `discovery/raw/phase2/order-fees-{redacted-id}-<ts>.json` x10
- `discovery/raw/phase2/order-history-{redacted-id}-<ts>.json` x10
- `discovery/06-phase2-results.md` (committed, redacted, summary)

## Stop-and-review checkpoint

After Phase 2:

1. I draft `06-phase2-results.md` with field-frequency analysis, status taxonomy, fee breakdown patterns, history event types.
2. **I do not start Phase 3 (slot probing) until Troy approves Phase 2 results.**
3. The schema draft (`01-schema.ts`) and the results doc are produced in the **same** review cycle so Troy can react to both together.

## Approval needed

Approve this plan to run, or revise it. Specifically tell me yes/no on:

- [ ] Block A (3 list calls).
- [ ] Block B (30 stratified detail calls).
- [ ] Block C (20 fee/history calls on 10 orders).
- [ ] PII handling plan as written.
- [ ] Throttle of 400ms.
- [ ] Stop-and-review after Phase 2 completes.

Default expectation: full approval, single yes, I run all blocks back to back with no further check-ins inside Phase 2.
