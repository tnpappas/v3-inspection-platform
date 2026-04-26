# Phase 1 Results, ISN Crawl

_Run 2026-04-26T18:31 UTC. 5 calls, 5 successes. Awaiting Troy's approval to proceed to Phase 2._

## Calls

| # | Method | Path | HTTP | Status | Bytes | Notable |
|---|---|---|---|---|---|---|
| 1.1 | GET | `/offices` | 200 | ok | 788 | 1 office |
| 1.2 | GET | `/users` | 200 | ok | 350,892 | 296 users, 19 active inspectors |
| 1.3 | GET | `/ordertypes/` | 200 | ok | 11,798 | 27 types, 16 visible, 11 hidden, no duration field |
| 1.4 | GET | `/contacttypes/` | 200 | ok | 65 | empty list |
| 1.5 | GET | `/agents` | 200 | ok | 1,364,081 | 8,934 agents, **stub records only** |

Raw responses saved to `discovery/raw/phase1/` (gitignored).

---

## Findings, ranked by impact

### 1. `/agents` and probably `/users`/`/clients` return stubs, not full records, on the bulk list

The `/agents` response of 8,934 records is the **stub form**: each record contains only `id`, `show`, `modified`. To see real fields like name, email, phone, license, agency, you must call `GET /agent/{id}` per agent.

This is the same pattern the docs call out for orders (footprints first, then per-id detail). It is a deliberate API design, but it has consequences for the rebuild plan:

- A "full" agent crawl is **8,934 detail calls**, not 1.
- Same will likely be true for `/clients` (could be tens of thousands of records).
- `/users` returned full records because that list is small (296). The API may switch to stub mode above some threshold, or it may always be stub. The crawl plan needs to assume stubs and only fetch detail where we need it.

**Implication for rebuild:** the schema and migration plan must work from sampled detail, not full extraction. Full agent/client extraction will happen as a separate, throttled batch job, not interactively.

### 2. There is no duration field on order types

I expected a `duration` or `minutes` field on `/ordertypes/`. There is none. The full record is:

```
id, office, name, description, publicdescription, sequence, show, modified
```

ISN's `/availableslots` endpoint accepts a `services` parameter, so the system clearly knows about service durations somewhere. Two hypotheses:

1. Duration is stored on a different entity (per-inspector service config, or a join table), not on the order type itself.
2. Duration is computed from booked orders historically, with no explicit configured duration.

Either way, **ISN does not surface inspection duration in the API reference data.** This is likely undocumented or buried elsewhere. The Phase 3 slot probing will tell us how `availableslots` actually computes windows.

**Rebuild deviation:** the new schema will store `duration_minutes` directly on the order type (or on a per-inspector-per-service join). Explicit beats implicit.

### 3. Order types are a mess

27 records in `/ordertypes/`. Of those:

- **5 are duplicate "Reinspection" entries**, four hidden, one visible. Years of accumulated test or migrated data not cleaned up.
- **2 are duplicate "Standard/basic Home Inspection"** entries with overlapping intent.
- **One is a literal string warning sign:** `"******Please don't use any of the inspection types below this line******"`. That is a row, not a separator. It has `show: "yes"`. A user-facing dropdown could render it.
- The currently-active list (`show: "yes"`) is 16 entries, but those include "SOLO INSPECTOR" variants and the warning row.

**Recommendation:** in the rebuild, order types get a real cleanup pass. We define the canonical list during the schema spec, archive the duplicates, retire the warning-row workaround. I will surface the proposed clean list when I draft `01-schema.ts`.

### 4. Inspector zip coverage is wildly uneven

Of 43 users with `inspector: "Yes"`, the ZIP-coverage stats are:

- min: 0
- median: 0
- max: 79

Half or more of inspector accounts have **zero zips configured**. That is consistent with your description that ISN tracks territory but does not enforce it. The dispatcher's brain is the real territory model.

**Rebuild opportunity:** geospatial assignment with real territory rules (ZIP + drive time + service area polygons) is a clear win over what exists.

### 5. The user list is bloated with disabled accounts

296 user records, only 32 with `show: "Yes"`. 264 are hidden. The breakdown of role flags includes:

- **193 users flagged `callcenter: "Yes"`.** This is suspicious. Either ISN sets `callcenter` true by default and never resets, or there genuinely was a phone-room operation at some point, or the flag means something other than what it sounds like.
- 19 active inspectors (`inspector: "Yes"` AND `show: "Yes"`). This bounds the answer to your earlier "8 to 12 active inspectors." 19 is your historical max with show-on; the actively-dispatched count is probably lower. **You owe a confirmation: 8 to 12 active is the dispatch reality. The 19 includes inspector accounts kept alive for legacy reasons. Confirm.**

### 6. `/contacttypes/` is empty

Zero contact types defined for Safe House. Either the feature is not used, or contact-typing is an out-of-the-box ISN list we have not customized. Not a blocker. The new system will define its own contact type taxonomy in the schema phase.

### 7. Office data is single-row and clean

One office, complete with lat/long (36.7765, -76.0368). The address has trailing whitespace (`"Virginia Beach "`, `"office@safehousepropertyinspections.com "`), which I will normalize on import. Otherwise the office record is the cleanest data we have seen so far.

---

## Spec-versus-reality drift, captured

- The OpenAPI spec describes `/agents` as returning agent records. It does, but only stubs. The spec does not flag this, and the response shape (no nested object structure to indicate stub-ness) does not announce itself. Users-of-the-spec assumption: "I called `/agents`, I now have agents." Reality: "I have 8,934 IDs and timestamps."
- `/agents` response includes `count: 8934` and `after: "na"`. Neither is in the spec. The `after` value being `"na"` (rather than null) suggests pagination/incremental sync hooks that exist in production but are undocumented. Adding to platform issues.

---

## Updated platform issues to log

I will append two more entries to `isn-platform-issues.md`:

- **#6:** Bulk list endpoints return undocumented "stub" records (id/show/modified only) above some threshold. The OpenAPI spec implies full records. Crawl planning gets thrown off without this knowledge.
- **#7:** Response fields `count` and `after` appear on `/agents` but not in the spec. Production has features the spec does not document.

---

## Proposed Phase 2 adjustments based on Phase 1

Original Phase 2 plan was:

- 2.1 `GET /orders?completed=false&after=<90 days>`
- 2.2 `GET /orders?completed=true&after=<30 days>`
- 2.3 `GET /orders/footprints?all=true`
- Then 25 sample detail calls × 3 endpoints each from each list (~150 calls).

**Adjusted plan:**

1. Run 2.1, 2.2, 2.3 first as planned.
2. **Inspect what `/orders` returns.** If it is stubs (likely, given `/agents` was), the math changes.
3. If stubs, fetch full detail on **a stratified 30-record sample** rather than 50. Stratify by:
   - Status (open vs completed)
   - Order type (cover at least the top 3 by frequency)
   - Inspector (cover at least 3 distinct inspectors)
   - Recency (cover at least one from each of the last 3 months)
4. Then `/order/fees/{id}` and `/order/history/{id}` only on a **further-trimmed 10-record sample** (Phase 2's stretch goal). Fees and history are deeper data and can wait if the order shape gives us enough on its own.

Net Phase 2 call count: ~50 instead of ~150. Same coverage of field surface, less PII, less throttle pressure.

---

## What I am waiting on

1. **Your confirmation** that 8 to 12 active inspectors is the dispatch reality. The 19 inspector-flagged-active accounts likely include legacy entries.
2. **Approval to run Phase 2** with the adjusted, stratified sampling plan above.
3. CSV exports from ISN UI when you have a chance (Users, Order Types, Agents, recent Orders).

Once you approve Phase 2, I will run it, summarize, and pause again before any further crawl.
