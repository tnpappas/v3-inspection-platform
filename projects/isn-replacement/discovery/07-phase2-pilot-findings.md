# Phase 2 Pilot Findings (Block B Recon)

_Run 2026-04-26 22:14 UTC. 8 pilot detail calls, all HTTP 200, ~70 KB each. Used to inform the rest of Block B before the larger sample runs._

## Pilot composition

5 freshest open + 3 freshest completed orders, sorted by `modified` desc, deterministic. All 8 had `modified` within the last ~36 hours.

## Headline: ISN orders are MUCH richer than expected

The 70 KB per-order payload (consistent across all 8 pilots) tells us most of the bulk is the **`controls` array (137 entries)** plus the **`fees` array (25 entries)**. The flat order has 97 distinct fields. Surface area we have to map is materially larger than the existing Replit `inspections` table.

## Field surface, summarized

### Always populated (47 of 97 fields, in 8/8 pilots)

These are the fields ISN definitively uses. Mostly map cleanly to v2 schema:

- **Identity / source:** `id`, `oid`, `office`, `invoicenumber`, `modified`, `createddatetime`, `createdby`
- **Address:** `address1`, `city`, `state`, `stateabbreviation`, `zip`, `latitude`, `longitude`, `mapurl`
- **Property:** `squarefeet`, `foundation` (UUID), `propertyoccupied`, `utilitieson`
- **People:** `client`, `inspector1`, `ordertype`
- **Scheduling:** `datetime`, `datetimeformatted`, `duration`
- **Money:** `totalfee`, `fees` (array), `osorder` (outsource flag)
- **Status flags (5 axes):** `complete`, `canceled`, `paid`, `signature`, `show`
- **Comm preferences:** `sendemailevents`, `sendsmsevents`, `ignoresignaturefordelivery`, `ignoresignaturepaymentfordelivery`, `ignorespaymentfordelivery`
- **Inspector requested flags 1-10:** `inspector1requested` ... `inspector10requested` (mostly "no")
- **Big nested:** `controls[]` (137 items), `fees[]` (25 items)

### Sometimes populated (7 fields, 4-7 of 8 pilots)

- `buyersagent` (7/8), `sellersagent` (6/8): UUIDs, link to ISN agents
- `costcenter` + `costcentername` (7/8): "Territory A" appears, **this is ISN's territory model surfacing on the order**, important
- `reportnumber` (7/8): format like `"1132 - 042426"`
- `scheduledby`, `scheduleddatetime` (7/8): who scheduled it, when
- `yearbuilt` (7/8)
- `referreason` (6/8): UUID, lookup to a reasons table
- `salesprice` (5/8): integer, default 0
- `services[]` (5/8): array of `{uuid, name}` references to services
- `county` (4/8)

### Multi-inspector confirmed (rare)

`inspector2`/`inspector3` slots populated on **2 of 8** pilots. Confirms multi-inspector orders happen in normal flow. Slots 4-10 unused in pilot, but the schema supports up to 10. We will keep our `inspection_inspectors` junction (no slot ceiling) as the better model.

### Lifecycle timestamps (3-4 of 8)

- `completedby` + `completeddatetime` (3/8): the 3 completed pilots
- `initialcompletedby` + `initialcompleteddatetime` (3/8): same 3, **same values**, but a separate field. Likely captures the FIRST completion vs the final (in case of QA reopen → recomplete cycle). Worth confirming with detail history calls.
- `osscheduleddatetime` (4/8): related to outsource (`osorder`)

### Empty in all 8 pilots (29 fields)

Likely unused at Safe House:

- `address2`, `gatecode`, `majorcrossstreets`
- `escrowofficer`, `insuranceagent`, `policyholder`, `policynumber` (escrow/insurance never populated, matches Phase 1 finding that Safe House does not use these)
- `coupons`, `taxes`, `packages`
- `contacts` (different from contact_types we already saw empty)
- `referredreason`, `cancelreason`, `cancelreasonstring`, `canceledby`, `canceleddatetime` (nothing cancelled in pilot)
- `confirmedby`, `confirmeddatetime`
- `deletedby`, `deleteddatetime`
- `inspector4` through `inspector10` (slots beyond 3 unused)
- `buyersagentcontactnotes`, `sellersagentcontactnotes`

**This is a clean cut list for the migration plan.** 30% of ISN's order surface is dead at Safe House.

## Deep findings

### 1. Status is encoded in 5 string flags, not a state machine

The order's status is the conjunction of:

- `complete: yes/no`
- `canceled: yes/no`
- `paid: yes/no`
- `signature: yes/no`
- `show: yes/no`

There is **no single "status" field** on the order. The dispatcher and inspectors infer status from the combination. ISN does not model state transitions explicitly, which is one reason "what's actually happening with order X" is dispatcher-tribal-knowledge.

**Implication for v2 schema:** the existing multi-axis pattern (status, paymentStatus, signatureStatus, qaStatus, reportReleased) is BETTER than ISN's, because it has an explicit `status` enum (`scheduled | confirmed | en_route | in_progress | completed | cancelled | no_show`). ISN can only express "completed" or "not completed." The migration will derive our `status` from the combination of ISN flags plus completedAt/cancelledAt timestamps.

### 2. The `fees[]` table is the line item ledger, with 25 fixed-row positions

Every pilot has exactly **25 fee rows**. The fee row IDs are stable across orders (same `id` UUID for "Inspection Fee" across all 8 pilots). This is **a fixed fee menu, with `amount` set per-order**. Most rows are 0, the populated rows are the actual line items.

Each fee has:
- `id` (UUID, stable across orders)
- `name` (string, e.g., "Inspection Fee", "Sewer Camera Inspection")
- `amount` (string or 0)
- `outsourceamount` (string)

**Implication:** ISN's "fees catalog" is a separate concept from "ordertypes." The fee menu has 25 line types Safe House actually charges for. Migration should:
1. Extract the 25 fee names as a fee catalog
2. Map each fee row on each order to a `inspection_services` row in v2

The current v2 schema's `services` table covers the catalog. The line items go to `inspection_services`. Already aligned.

### 3. The `controls[]` array is custom-form-builder territory, 137 entries per order

`controls` is ISN's user-extensible-fields system. Sample names:

- "Date Received"
- "Complaint Managed By", "Complaint Category 1", "Complaint Legitimacy 1" (a quality complaints log)
- "Escrow Fields", "Escrow Officer"
- "**SPELL BACK PHONETICALLY**" (call-script prompts, not fields)
- "< YOU > Ok, and let me go ahead and get your name as it should appear..." (more call scripts)
- "Client Information", "Access", "Concerns", "Outbuildings", "Add'l Services", "Payment", "Notes", "Termite Inspections"
- "Refund Amount ($) / Category 1"

Two distinct uses of `controls[]`:

a. **Genuine custom data fields** (Date Received, Complaint Category, Refund Amount). These are workflow data Safe House captures per order.

b. **Embedded call-center scripts** (the "< YOU >" entries, "**SPELL BACK PHONETICALLY**"). These are dispatcher reading prompts that someone abused the controls system to embed on every order. **They are not data, they are content for office staff during phone intake.**

**Implication for v2:**
- The genuine custom fields need a **`inspection_custom_fields`** table or jsonb column (decision deferred to schema rationale).
- The call-center scripts do NOT belong in the order data model. They belong in an **office workflow / scripts** module, separate from inspection records.
- This is a major migration cleanup opportunity. ISN forced Troy to abuse the customs system because there was no script-management feature.

### 4. Cost centers / territories surface on orders

`costcenter` (UUID) + `costcentername` ("Territory A") on 7/8 pilots. ISN has a **territory model** that we did not see in `/users` or `/offices`. Territories are likely a separate ISN entity tied to dispatcher routing.

**Implication for v2:** add a `territories` table (or fold into `offices` if Safe House uses 1:1 territory:office). Phase 3 (slot probing) may surface more about how territories interact with availability.

### 5. The `osorder` and `outsource` pattern

Every pilot has `osorder: yes` and matching `osscheduleddatetime` on 4/8. Outsource is the ISN concept where work is delegated to a partner inspector. `outsourceamount` on each fee row tracks what the partner gets paid.

**Implication for v2:** outsourcing is a real workflow at Safe House (or was historically). Not in scope for this slice, but we should not rip it out blindly during migration. Capture in field mapping doc as "preserve, surface in later slice."

### 6. Property `foundation` is a UUID, not a string

ISN uses lookup tables for property metadata (foundation type), states (we already knew), and likely others. The pilot does not populate `propertyType`, but if ISN has it, expect another UUID.

**Implication for v2:** the v2 schema currently models `properties.foundation` as `varchar(100)`. **Recommend keeping varchar with a controlled vocabulary, not migrating ISN's UUID lookup table.** Migration translates the UUID → string at import time. Note for the schema rationale.

### 7. Booking and confirmation timestamps are richer than the v2 schema captures

ISN has separate timestamps for:

- `createddatetime` (when the order was created)
- `scheduleddatetime` (when it was scheduled)
- `osscheduleddatetime` (when the outsource was scheduled)
- `confirmeddatetime` (when client confirmed; empty in pilot)
- `completeddatetime` (final completion)
- `initialcompleteddatetime` (first completion, possibly before QA reopen)
- `deleteddatetime` (soft-delete timestamp; empty in pilot)
- `canceleddatetime` (cancellation; empty in pilot)

The v2 schema has `createdAt`, `cancelledAt`, `completedAt`, `reportReleasedAt`, but **does not have `scheduledAtConfirmed`, `confirmedAt`, or `initialCompletedAt`**.

**Recommendation:** add `confirmedAt` and `initialCompletedAt` to the `inspections` table in v2. The "client confirmed" and "first completion before QA reopen" signals are useful operationally.

### 8. Comms preference flags suggest per-order opt-out

`sendemailevents: yes/no`, `sendsmsevents: yes/no`, plus the three `ignore*fordelivery` flags suggest:

- Per-order client communication preferences (e.g., "this client asked us not to email them")
- Per-order delivery overrides ("ignore signature requirement when releasing report")

The v2 schema has these as customer-level (`emailOptIn`, `smsOptIn`). ISN allows per-order overrides. **Decide:** customer-level only, or per-order overrides supported? The pilot data suggests Safe House actually uses per-order overrides on rare occasion (the override flags are in every order, even if always "no").

Recommendation: customer-level by default (simpler), per-order overrides as a future feature when demand surfaces. Document the decision in schema rationale.

## Implications for the rest of Block B

The pilot already gave us 80% of the field shape. **A full 30-order Block B is no longer the right next step.** Better plan:

### Revised Block B plan

1. Augment the pilot to **15 total orders** with these added 7:
   - 1 cancelled order (sample any with `canceled=yes`)
   - 1 from a different inspector (the pilots had a small inspector pool by accident of recency)
   - 2 from order types other than the dominant Home Inspection (sample by randomly picking from `services` UUIDs we have not yet seen)
   - 1 multi-inspector order with 3+ slots populated
   - 1 with `outsource=yes` and a populated `osscheduleddatetime`
   - 1 from at least 60 days back (test the `modified` field on aged orders)

2. **Skip the original 30-detail call commitment.** Saves us 15-22 calls. We have the field surface; what remains is edge-case validation, not coverage.

3. Block C (fees + history) on **5 orders**, not 10. The fees table is fixed (we already know its shape). History is the unknown; 5 history calls reveal the event vocabulary.

**Revised Phase 2 total: ~13 more calls** (7 augment + 5 history + 1 contingency), bringing us to **~24 total Phase 2 calls** instead of the originally-planned 50.

## What I am NOT doing yet

- Not running the augment calls. Awaiting Troy's approval of the revised plan.
- Not committing to the v2 schema deltas (add `confirmedAt`, `initialCompletedAt`; add `territories` consideration; document custom-fields strategy). Those go into the schema rationale doc on review-pass.
- Not pulling fees or history endpoints. That is Block C.

## Decisions Troy should weigh in on

1. **Approve the revised Block B (7 augment calls) and Block C (5 history calls)?** 12 more calls total, plus contingency.
2. **Custom fields in v2 schema:** dedicated `inspection_custom_fields` table OR `inspections.custom_fields` jsonb column? My lean: jsonb on the inspection. Simpler, queryable in Postgres, no joins, and the 137-entry vocabulary is per-tenant anyway.
3. **Confirmed_at and initial_completed_at columns:** add to v2 inspections table now, or defer? My lean: add now. Cheap, captures real ISN signal we are losing otherwise.
4. **Call-center scripts:** I will scope a future "office workflow / scripts" module. Not building tonight, just want to flag the concept exists outside the inspections data model. OK to defer?

## Review format reminder

Per Troy's earlier message: schema review is **inline markup**. When you start the schema review, add `// REVIEW(troy):` comments to `specs/01-schema.draft.ts` and I will respond with `// HATCH:` replies under each.
