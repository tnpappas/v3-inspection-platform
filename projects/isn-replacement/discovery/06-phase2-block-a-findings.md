# Phase 2 Block A Findings

_Run 2026-04-26 21:14 UTC. 3 list calls, 3 successes by HTTP status, but two of them surface real data hygiene issues with ISN's API behavior. Block B and Block C remain paused pending Troy's review._

## Calls

| # | Method | Path | HTTP | Bytes | Result |
|---|---|---|---|---|---|
| 2.1 | GET | `/orders?completed=false&after=2026-01-26T...` | 200 | 5,660,928 | 37,032 stub records |
| 2.2 | GET | `/orders?completed=true&after=2026-03-27T...` | 200 | 3,726,382 | 24,355 stub records |
| 2.3 | GET | `/orders/footprints?all=true` | 200 | 44 | empty array |

Raw responses saved to `discovery/raw/phase2/` (gitignored).

## Findings

### 1. `/orders` returns stub records, same as `/agents`

Each order in the response has only three fields: `id`, `show`, `modified`. The OpenAPI spec implies full `Order` objects. Confirmed not the case at this scale. To get real fields we must call `GET /order/{id}` per record. Same as Phase 1's `/agents`. **The earlier hypothesis that `/orders` might return full records was wrong. Stubs are the rule.**

### 2. ISN's `after=` filter on `/orders` appears to be ignored

Two requests with explicit `after` parameters returned the entire historical lifetime of matching orders, not the requested windows:

- `after=2026-01-26` (90 days back), expected ~600 open orders given Troy's stated ~200/month volume. **Got 37,032.**
- `after=2026-03-27` (30 days back), expected ~200 completed orders. **Got 24,355.**

The response also returned `"after": "na"` at the top level, the same string value seen on `/agents`. This is the same behavior pattern: ISN advertises an incremental-sync filter, the filter does not work, and the response indicates "not applicable" without explaining why.

**Logged as platform issue #8.** Will be appended to `isn-platform-issues.md`.

Total order count: 37,032 + 24,355 = **61,387 orders in ISN's lifetime for Safe House.** This is much larger than 1,950 inspections in 2025 (Troy's stated number), which means the `/orders` endpoint includes orders that are not inspections, includes test data, includes archived/voided orders, or some combination. We will only know once we look at detail records.

### 3. `/orders/footprints?all=true` is not the cross-inspector view I hoped for

Returned `{"status": "ok", "footprints": []}`. The owner-only `all=true` flag works (no error) but the queue is empty because no third-party tool has been polling footprints recently. **Footprints are NOT a "current schedule" snapshot.** They are transient hooks that get deleted by integrators after consumption. Useless for our discovery purposes.

### 4. Sampling implications for Block B

Stub records cannot be stratified by inspector, order type, or status because none of those fields are in the stub. The only signal in the stub is `modified` (timestamp). Three options for proceeding to detail calls, ranked by benefit:

1. **Pilot recon.** Pull detail on 5 to 8 stubs first (sorted by `modified` desc), look at the field shape, then design a smarter stratification rule for the remaining ~25 detail calls. Costs 5 to 8 extra calls. Lowest risk of bias.
2. **Naive freshest-first.** Sort all stubs by `modified` desc, pull the freshest 25 from open + freshest 5 from completed. Simple, deterministic, biased toward recently-edited records.
3. **Random sample.** Pull 30 random stubs across both lists. Better statistical balance, less repeatability.

Block B remains paused. Troy chooses the strategy on resume.

### 5. Total ISN order count is a margin signal in itself

61,387 lifetime orders against Troy's stated 1,950 in 2025 alone implies either ~13 years of accumulated data (Safe House started 2013, plausible) or substantial test/archived noise. Either way, **the migration plan must classify ISN orders before importing**, not just import them all. Decision criteria likely:

- Status not in `{cancelled, voided, draft, test}`
- Created or modified within the last N years (cutoff TBD)
- Has a real customer attached (not a placeholder)

Captured for the migration plan when it is drafted.

## Platform issue #8, draft text for `isn-platform-issues.md`

> ISN's `/orders` endpoint advertises an `after=<timestamp>` filter via the OpenAPI spec, intended for incremental sync. In practice the filter is ignored: requests with explicit `after` parameters returned full lifetime lists (37,032 + 24,355 records) when narrow windows (90 days, 30 days) at the documented volume should have returned ~800 records. The response includes `"after": "na"` at the top level, mirroring the same string-value behavior on `/agents`. Either the filter is unsupported and the spec is wrong, or it is supported but silently failing. Either way, integrators following the spec literally will pull massive datasets when they intend to pull diffs.\n\nWill be appended to the platform-issues file when Troy confirms.

## What is not in this Block A

- No customer PII was pulled. Stubs contain UUIDs and timestamps only.
- No order detail. That is Block B's job.
- No write operations attempted at any point.

## Pause status

Block B and Block C are not running. Resume requires:

1. Troy's choice of sampling strategy from the three options above.
2. Optional: explicit confirmation to log platform issue #8 to the rebuild justification doc.
3. Awareness that the eventual Phase 2 results doc will map data into the new multi-business v2 schema, not the v1 single-business draft.
