# Phase 4: Comprehensive ISN API Audit

_Completed 2026-04-28. Every endpoint in the spec probed with all parameter variations. Undocumented endpoints discovered and documented. Full field sets for every entity type. Gap analysis vs. prior phases. Schema and migration impact assessed._

---

## Audit scope and method

- Pulled the live Swagger spec from `http://api.inspectionsupport.net/swagger/isn.json` (identical to cached `isn-openapi.json` — same version 8400)
- Probed 45 undocumented path patterns
- Tested all query parameter variations on all GET endpoints
- Pulled full extended records for orders with every known flag combination
- Compared Replit project code for any ISN API calls (none — the Replit project is a standalone build, not an ISN integration)
- Decompiled the ISN API Explorer JS bundle to find the Swagger source path

---

## 1. Undocumented live endpoints discovered

Five endpoints exist in production with no entry in the OpenAPI spec:

### `GET /costcenters`

**Status:** Live, HTTP 200  
**Returns:** 2 cost center records

```
Fields: id, office, name, email, phone, url, address1, address2, city, state, zip, show
```

Safe House has two cost centers:
- **Territory A**
- **Territory B**

ISN uses cost centers as geographic territory grouping. The address fields are present but empty (state shows "AL" — artifact). The `costcenter` UUID on orders and `costcentername` (human-readable) both come from this table.

**Migration impact:** Add `costcenters` lookup table to v3 or store `costcentername` string on `inspections`. String storage is simpler — "Territory A" / "Territory B" is stable enough to denormalize. **Recommendation: store `costCenterName varchar(100)` on `inspections` and skip a separate table.**

---

### `GET /referreasons`

**Status:** Live, HTTP 200  
**Returns:** 17 referral reason records

```
Fields: id, office, reason, show, modified
```

All 17 reasons (show=yes unless noted):

| # | Reason |
|---|---|
| 1 | Referred By Friend |
| 2 | BA Booked on Website |
| 3 | Agent called and scheduled |
| 4 | Google Search |
| 5 | Facebook |
| 6 | Yelp |
| 7 | Other |
| 8 | Client called - referred by agent |
| 9 | Agent called referred by another agent |
| 10 | Client Request Quote - Referred by Agent |
| 11 | BAA texted us |
| 12 | Online Google Ad |
| 13 | Online Facebook Ad |
| 14 | BAA sent an email |
| 15 | Client Request Quote - Online Search |
| 16 | Client called referred by agent _(show=no, duplicate of #8)_ |
| 17 | Client scheduled online |

**Migration impact:** The `referreason` UUID on orders maps to this table. For migration, resolve UUID → reason string and store the text. **Recommendation: store `referReasonText varchar(200)` on `inspections`, resolved during migration from this lookup.**

---

### `GET /services`

**Status:** Live, HTTP 200  
**Returns:** 20 service definitions

```
Fields: id (UUID), sid (integer), office, name, privatename, inspectiontypeid, 
        inspectiontype (embedded object), label, modifiers (array), ancillary, 
        visible, visible_order_form, sequence, is_pac, description, 
        perceptionist_name, questions (array)
```

Safe House's 20 services (current):

| sid | Name | ancillary | visible | inspectiontype |
|---|---|---|---|---|
| 1 | Residential Inspection - Virginia | No | Yes | Home Inspection |
| 3 | Sewer Camera Inspection - w/ Inspection | Yes | Yes | (none) |
| 4 | Indoor Air Sampling - w/ Inspection | Yes | Yes | (none) |
| 5 | Mold Surface Sample | Yes | No | (none) |
| 6 | Outbuilding Inspection - Utility Shed | Yes | Yes | (none) |
| 8 | Swimming Pool Inspection w/ Inspection | Yes | Yes | (none) |
| 9 | Water Loss Evaluation w/ Pool Inspection | Yes | Yes | (none) |
| 11 | Residential Inspection - North Carolina | No | Yes | NC Home Inspection |
| 13 | Indoor Air Sampling - Stand Alone | No | No | Air Sampling SA |
| 14 | Outbuildings - w/ Living Quarters | Yes | Yes | (none) |
| 15 | Outbuildings - w/ Utilities | No | Yes | (none) |
| 18 | Pay At Closing Convenience | No | No | (none) |
| 20 | Decontamination Service | Yes | Yes | (none) |
| 23 | Pest Heroes Termite/Moisture Promo | No | Yes | (none) |
| 25 | Sewer Camera Inspection - No Home Inspection | No | Yes | Home Inspection |
| 26 | No Real Estate Agent Transaction | No | No | (none) |
| 27 | Residential Pre-Listing Inspection | No | Yes | Pre-Listing Inspection |
| 29 | Pre-Listing Photographs | Yes | No | (none) |
| 31 | Solar Inspection w/Inspection | No | Yes | (none) |
| 32 | Solar Inspection - Stand Alone | No | No | (none) |

**New fields not in spec:**
- `sid` — stable integer ID (1, 3, 4…) used for cross-referencing. More stable than UUID for ISN-internal operations.
- `ancillary` — boolean. If true, this is an add-on service, not a primary inspection type.
- `visible` — whether visible to the dispatcher booking form.
- `visible_order_form` — whether visible to the client-facing online booking form.
- `is_pac` — "Pay at Close" flag.
- `perceptionist_name` — alternate name for the ISN Perceptionist tool (booking AI).
- `modifiers` — price modifier array (pricing rules).
- `questions` — array of booking questions for this service.
- `inspectiontype` — embedded object with the full inspection type record (id, name, description, sequence, fee).

**Migration impact:** The v3 `services` table needs these fields. Current spec 04 treats services as a basic name/price mapping. The actual service model is richer:
- `services.sid integer` — ISN's integer service ID
- `services.ancillary boolean` — add-on vs. primary
- `services.visibleToDispatcher boolean`
- `services.visibleOnlineBooking boolean`
- `services.isPac boolean`
- `services.modifiers jsonb` — price modifier rules
- `services.questions jsonb` — booking questions
- `services.inspectionTypeId` — FK to inspection types

---

### `GET /fees`

**Status:** Live, HTTP 200  
**Returns:** 71 fee configuration records (ISN's fee/pricing matrix)

```
Fields: id, office, officeid, name, servicedescription, defaultamount, taxable, 
        coupon, basefee, mileage, zipcode, reinspection, foundation, propertyage, 
        salesprice, ordertype, convenience, county, sequence, show, modified, is_pac
```

The `/fees` endpoint is ISN's fee pricing engine configuration — not the fees on a specific order. These are the 71 rules that ISN uses to calculate what to charge based on property attributes. Key fee types observed:

| Name | defaultamount | basefee | notes |
|---|---|---|---|
| Inspection Fee | 0 | Yes | Base; amount calculated from pricing rules |
| Sewer Camera Inspection | 219 | No | Flat add-on |
| Sewer Camera - Discounted | 189 | No | When added with home inspection |
| Indoor Air Sampling | 0 | No | Variable |
| Crawlspace | 25 | No | Foundation surcharge |
| Trip Fee | 50 | No | Mileage-based |
| Discount | 27 | No | Standard discount |
| Pool / Spa Inspection Fee | 75 | No | |
| Refund | 0 | No | Refund placeholder |
| Pay At Close Fee | 0 | No | |

**Boolean fee triggers** (when true, this rule applies):
- `basefee` — the primary inspection fee
- `coupon` — applicable to coupon codes
- `mileage` — triggered by distance
- `zipcode` — ZIP-based pricing
- `reinspection` — reinspection discount applies
- `foundation` — foundation type affects price
- `propertyage` — year built affects price
- `salesprice` — sale price bracket affects price
- `ordertype` — order type affects price
- `convenience` — convenience surcharge
- `county` — county-based pricing
- `is_pac` — pay-at-close fee

**Migration impact:** This endpoint represents ISN's pricing matrix — not directly part of customer data migration but essential for replicating the pricing engine in v3. The v3 fee/pricing model needs to support these same rule types. For the current migration phase, fees per order are already captured in the `order.fees[]` array. `/fees` is the configuration, not the transaction data.

---

### `GET /order/notes/{id}`

**Status:** Live, HTTP 200  
**Returns:** Array of notes on a specific order

```
Fields per note: temp (boolean), dte (datetime string), user (object: {id, display}), text (string)
```

Sample:
```json
{
  "temp": false,
  "dte": "2026-04-21 09:52:30",
  "user": {"id": "<UUID>", "display": "Jelai Cachin"},
  "text": "Birdneck Lake is a vibrant community known..."
}
```

Notes come in two flavors observed:
1. **Dispatcher notes** — text added during booking or scheduling (user = actual dispatcher UUID + display name)
2. **System notes** — auto-generated by ISN (e.g. "Credit card charged for order totaling: $561.95"; user = `[]` empty array, not an object)

**Migration impact:** Order notes should be migrated to `inspection_notes` (or `inspections.customFields.notes`). The `user` field can be either an object `{id, display}` or an empty array `[]` — migration must handle both.

**New table needed or customFields?** The v3 schema has an `audit_log` but no dedicated `inspection_notes` table. Order notes from ISN are operational notes (dispatcher context, system events) — store them in `inspections.customFields.isnNotes` as a JSON array rather than creating a new table. Low operational value post-migration.

---

## 2. Query parameter variations — what works

### `GET /order/{id}` — only two flags change the response

| Flag | Effect |
|---|---|
| `withallcontrols=true` | Adds `controls` array (137 items, ~60KB). Only flag that significantly expands data. |
| `withpropertyphoto=true` | Adds `propertyphoto` UUID field. Minimal size increase. |
| All other flags tested | No effect (returns same 11,907-byte base response): `withhistory`, `withfees`, `withinspectors`, `withparticipants`, `withattachments`, `withpayments`, `withcommunications`, `withservices`, `withall`, `full`, `expand` |

**Conclusion:** Only `withallcontrols=true` and `withpropertyphoto=true` matter. All migrations must use both.

### `GET /orders` — confirmed working filters

| Parameter | Works? | Notes |
|---|---|---|
| `completed=true` | ✓ | Returns 24,367 completed orders (stubs) |
| `completed=false` | ✓ | Returns 37,062 pending/active orders (stubs) |
| `after=<datetime>` | ✗ | Silently ignored (Platform Issue #8) |
| `datetimeafter=<datetime>` | ✗ | Returns 0 results (Platform Issue #12) |
| `uuids=<uuid>` | ✓ | Returns 1 stub for the matching UUID |
| `agentuuid=<uuid>` | ✗ | Returns full list (silently ignored, no agent UUID was set in test) |

### `GET /orders/footprints?all=true`

Returns empty footprints array. The `all=true` flag is documented as "Only users who can view all inspections can use this." Troy's credentials are owner-level, so this should work — but the footprint list is empty. Likely because footprints are ephemeral and nothing has been scheduled for the API user's inspector scope recently. Not a useful data source.

### `GET /orders/search` — parameters tested

| Parameter | Works? | Notes |
|---|---|---|
| `year=2026` | ✓ | Returns 848 stubs |
| `address1=<text>` | ✓ | Returns matching stubs |
| `datetime=<date>` | ✗ | Returns 0 results |
| `reportnumber=<value>` | ✗ | Returns 0 results (Platform Issue #13) |
| `client=<uuid>` | ✗ | Returns 0 results (broken — client UUID search non-functional) |

### `GET /clients`, `/agents`, `/agencies`, `/users`, `/escrowofficers` — `uuids=` batch

| Endpoint | `uuids=<single_uuid>` result |
|---|---|
| `/orders` | ✓ Returns 1 stub — works |
| `/clients` | Returns 1 stub — works |
| `/agents` | Returns 1 stub — works |
| `/users` | ✗ Returns ALL 296 users — silently ignored |
| `/agencies` | ✗ Returns all 1,290 agencies — silently ignored |
| `/escrowofficers` | Returns 1 stub — works |

**Platform Issue #14:** `uuids=` batch parameter is silently ignored on `/users` and `/agencies`, returning the full list instead of the filtered subset.

### Entity flags — none work

All flag combinations tested on `/client/{id}`, `/agent/{id}`, `/agency/{id}`, `/user/{id}`:
- `withorders`, `withhistory`, `withagency`, `withinspections`, `withfiles`, `withattachments`, `expand`, `full`

None expand the response. Entity endpoints have no flag-based expansion.

---

## 3. Complete field sets for every entity type

### `GET /me` and `GET /user/{id}` — 33 fields

```
id, office, username, firstname, lastname, displayname, emailaddress, 
address1, address2, city, state (UUID), stateabbreviation, zip, county,
phone, mobile, fax, license, licensetype, sendSMS, inspector, owner, 
manager, officestaff, callcenter, thirdparty, show, ipaccesskey, ipsecretkey,
bio, photourl, modified, zips (array of 72 ZIP codes)
```

`/me` returns same shape with `me` as the container key vs `user`. `/user/{id}` uses `user` key.

Key notes:
- `photourl` points at `v3.isnbin.com/api/v3/jpeg?key=safehouse&bin=101&file=...`
- `zips` is the inspector's service territory — 72 ZIP codes for Troy
- `state` field is a UUID (not abbreviation); use `stateabbreviation`
- Role fields: `inspector`, `owner`, `manager`, `officestaff`, `callcenter`, `thirdparty` — all string "Yes"/"No"

### `GET /client/{id}` — 26 fields (CORRECTED from Phase 3)

```
id, first, last, display, email, url, companyname, address1, address2, 
city, state (UUID), stateabbreviation, zip, workphone, homephone, mobilephone,
mobilephone2, mobilephone3, workfax, homefax, notes, send_sms, send_email, 
porch, modified, show
```

### `GET /agent/{id}` — 34 fields (CORRECTED from Phase 3)

```
id, agency (UUID), first, last, display, email, url, address1, address2,
city, state (UUID), stateabbreviation, zip, latitude, longitude, workphone,
homephone, mobilephone, mobilephone2, mobilephone3, workfax, homefax, notes,
sendsms, sendemail, bio, lastactive, labels, redactive, redurl, show, 
modified, img, tc
```

### `GET /agency/{id}` — 20 fields

```
id, name, display, emailaddress, address1, address2, city, state (UUID),
stateabbreviation, zip, url, phone, fax, show, modified, logourl, active,
lastactive, labels, notes
```

Note: `phone` (not `workphone`), `emailaddress` (not `email`), no fax separate from `fax`.

### `GET /escrowofficer/{id}` — 16 fields (CORRECTED from Phase 3)

```
id, office, firstname, lastname, displayname, email, url, address1, address2,
city, state (UUID), stateabbreviation, zip, phone, fax, cellPhone
```

Note: `cellPhone` (capital P), uses `firstname`/`lastname`/`displayname` like users.

### `GET /escrowoffice/{id}` — 14 fields (new — integer ID!)

```
id (INTEGER, not UUID!), name, email, fulladdress, address1, address2, city,
state_id (integer), state (full name), stateabbreviation, zip, phone, fax, url
```

**Critical:** Escrow offices use integer IDs internally (id=3, etc.), not UUIDs. The UUID seen on the list endpoint stubs maps to a different identifier. `fulladdress` is a pre-formatted string with `<br/>` separators. `state_id` is an integer (47 = Virginia).

### `GET /offices` — 16 fields

```
id (UUID), name, slug, address (single field, not address1/address2), city, 
state (abbreviation), zip, county, latitude, longitude, manager, manageremail,
phone, fax, url, helpdeskid, show
```

Note: `address` is a single field (not split), `state` is already the abbreviation (no UUID), `manager` is a display name string (not UUID), `helpdeskid` is an integer.

### `GET /order/{id}` — 98 fields (full extended)

All 98 fields documented in Phase 3 findings. Complete list:

```
id, oid, canceled, show, complete, paid, signature, osorder, office,
datetime, datetimeformatted, duration, createddatetime, createdby,
scheduleddatetime, osscheduleddatetime, confirmeddatetime, deleteddatetime,
canceleddatetime, completeddatetime, initialcompleteddatetime, scheduledby,
canceledby, confirmedby, deletedby, initialcompletedby, completedby,
referreason, referredreason, cancelreason, cancelreasonstring,
client, buyersagent, sellersagent, buyersagentcontactnotes, sellersagentcontactnotes,
insuranceagent, escrowofficer, squarefeet, salesprice, yearbuilt, totalfee,
reportnumber, invoicenumber, address1, address2, city, state (UUID), 
stateabbreviation, zip, county, latitude, longitude, majorcrossstreets, mapurl,
policynumber, policyholder, inspector1–inspector10, inspector1requested–inspector10requested,
sendemailevents, sendsmsevents, ignoresignaturepaymentfordelivery, 
ignoresignaturefordelivery, ignorespaymentfordelivery, contacts (array),
ordertype, foundation, costcenter, costcentername, fees (array), coupons (array),
packages (array), taxes (array), propertyoccupied, utilitieson, gatecode,
controls (array, 137 items), services (array), modified, propertyphoto
```

### `GET /order/history/{id}` — 18 history entries

```
Fields per entry: uid (UUID), by (display name string), when (ISO 8601 Pacific time), changes (object: field_name → new_value)
```

The history is ISN's own audit log. `changes` is a dictionary of what changed:
- `{"Created By": "Jelai Cachin", "Inspection Date": "04/21/2026", ...}`
- `{"Total Fee": "$0.00", "Order Paid": "Yes"}`
- `{"Inspector #1": "Michael Schar", "Inspector #2": "[none]", ...}`
- `{"Latitude": 38.00234, "Longitude": -78.224935}`

**Migration impact:** ISN history is a human-readable changelog, not a structured event log. Preserve as JSON in `inspections.customFields.isnHistory`. Do not attempt to parse the `changes` dictionary into structured v3 audit events.

### `GET /order/notes/{id}`

```
Fields per note: temp (boolean), dte (datetime ISN local), 
                 user ({id, display} OR [] for system notes), text (string)
```

### `GET /order/fees/{id}`

Returns fees array (same structure as `order.fees[]` in the extended order fetch). The standalone endpoint returned 0 fees for the tested order (the fees appear in the full order record but not via this endpoint for the same order). Possibly a timing/cache issue. Use the `order.fees[]` from the extended order fetch instead.

### `GET /services` (undocumented)

```
Fields: id (UUID), sid (integer), office, name, privatename, inspectiontypeid,
        inspectiontype (embedded object), label, modifiers (array), ancillary,
        visible, visible_order_form, sequence, is_pac, description, 
        perceptionist_name, questions (array)
```

The `inspectiontype` embedded object (when present):
```
id (UUID), _id (integer), name, description, publicdescription, sequence, fee, show
```

### `GET /fees` (undocumented)

```
Fields: id, office, officeid, name, servicedescription, defaultamount, taxable,
        coupon, basefee, mileage, zipcode, reinspection, foundation, propertyage,
        salesprice, ordertype, convenience, county, sequence, show, modified, is_pac
```

### `GET /costcenters` (undocumented)

```
Fields: id (UUID), office, name, email, phone, url, address1, address2, city, state, zip, show
```

### `GET /referreasons` (undocumented)

```
Fields: id (UUID), office, reason, show, modified
```

### `GET /ordertypes/` and `GET /ordertypes` (both work)

Both paths return the same 27 order type records:
```
Fields: id, office, name, description, publicdescription, sequence, show, modified
```

---

## 4. Controls lookup tables (extracted from order controls)

The `controls` array on extended orders contains the full ISN booking call script with embedded option sets. Key lookup tables discovered:

### Foundation types

```json
{"3": "Slab", "4": "Crawlspace"}
```

Only two options. The `foundation` UUID on orders maps to option key 3 or 4.

### Inspection order types (from OrderType control)

```
6: Home Inspection
7: Reinspection
11: Home Inspection with Sewer Camera Inspection
12: Home Inspection with Air Sampling Package
14: Air Sampling - Stand Alone Service
15: Home inspection with sewer camera and air sampling
16: North Carolina Home Inspection
17: Partial Inspection
18: *** Do not use below this line ***
19: Home Inspection - SOLO INSPECTOR
20: basic home inspection
21: Sewer Camera Inspection - Stand Alone
22: Pre-Listing Inspection
23: Stand Alone Swimming Pool Inspection
24: Stand Alone Decontamination Service
25: Indoor Air Quality Testing with Comprehensive Moisture Evaluation
26: Life Safety Inspections
27: Reinspection SOLO Inspector
```

### Complaint categories (3 complaint slots)

34 categories per slot including: Attic, Roof, Plumbing, Electrical, Drywall Damage, Windows/Doors, Appliance, Foundation, Crawlspace, Exterior, Pool/SPA, Heating/Cooling, Garage, Sprinklers, WDO/Pest/Termites, Septic, Out Building, Mold, Personal Belongings, Inspector Broke an Item, Insurance Issues, Report Errors, Time complaints, Behavior/Communication, Home Not Left in Same Condition, Office Staff issues, Scheduling Error, Concierge Email/Calls, Too many messages.

Legitimacy ratings: `Area Identified During Inspection`, `Area Not Identified During Inspection`, `Area Partially Identified During Inspection`.

**Migration impact:** The complaint data embedded in controls is Safe House's post-inspection QA process. Preserve in `inspections.customFields.complaints` as structured JSON — this is operationally valuable for quality tracking in v3.

---

## 5. What does NOT exist in ISN

- No `/reports`, `/stats`, `/analytics`, `/dashboard`, `/metrics`, `/export` endpoints (confirmed)
- No `/payments`, `/transactions`, `/refunds` endpoints
- No `/agreements`, `/signatures` endpoints
- No `/webhooks`, `/integrations` endpoints
- No `/emails`, `/sms`, `/communications` endpoints
- No `/attachments`, `/files` endpoints (order attachments are write-only via PUT)
- No separate reporting API or alternate base URL
- No `/v1/` or `/v2/` path prefix (both return 401)
- No admin-accessible subpath
- The ISN API is purely a CRUD and data-access surface. All workflows (agreements, signatures, payment processing, communications) are handled inside the ISN web UI only.

---

## 6. Replit project reverse-engineering

The existing Replit project (`isn-killer`) makes zero ISN API calls. It is a completely standalone replacement built with its own database and API. The Replit code contains only internal v1 API routes (`/api/inspections`, `/api/contacts`, etc.) — no ISN integration code. Nothing missed from the Replit project.

---

## 7. ISN API Explorer JS bundle analysis

The ISN API Explorer (`api.inspectionsupport.net`) loads its Swagger UI from `/swagger/isn.json`. The main JS chunk reveals:
- POST/PUT/DELETE are blocked in the Explorer UI (read-only demo mode)
- The spec is served at exactly one path: `/swagger/isn.json`
- No secondary spec files, no versioned specs, no hidden spec paths found in the bundle
- The library bundle is 1.2MB but contains only the Swagger UI library code — no ISN-specific paths embedded

---

## 8. Platform issues discovered in Phase 4

**Platform Issue #14:** `uuids=` batch parameter silently ignored on `/users` and `/agencies`. Returns full list instead of filtered subset. The same parameter works correctly on `/orders`, `/clients`, `/agents`, `/escrowofficers`.

**Platform Issue #15:** `/orders/search?client=<uuid>` returns 0 results even for clients with confirmed orders. The client UUID search parameter is non-functional.

**Platform Issue #16:** The `escrowoffice` list endpoint stubs use UUIDs but `GET /escrowoffice/{id}` uses an integer ID (`id: 3`). The UUID and integer are different identifiers. The list endpoint stubs are inconsistent with the detail endpoint. Phase 3 was unable to pull an escrow office by the UUID from the list because the detail endpoint uses integers.

---

## 9. Impact summary: gaps between prior knowledge and reality

| What we thought | What is actually true |
|---|---|
| Only `withallcontrols` and `withpropertyphoto` exist as flags | Confirmed. All other flags are no-ops. |
| ISN has no services endpoint | Wrong. `/services` (undocumented) returns all 20 services with rich detail. |
| ISN has no fee configuration endpoint | Wrong. `/fees` (undocumented) returns all 71 pricing rules. |
| Order notes are captured via order history | Wrong. `/order/notes/{id}` is a separate undocumented endpoint. |
| ISN has no referral reason or cost center lookup | Wrong. `/referreasons` (17 records) and `/costcenters` (2 records) are live undocumented endpoints. |
| Replit project might contain ISN API calls | Wrong. Zero ISN calls in the Replit code. |
| JS bundle might contain hidden paths | Wrong. The bundle only contains Swagger UI library code. |
| `uuids=` batch parameter works on all list endpoints | Wrong. Silently ignored on `/users` and `/agencies`. |
| `orders/search?client=<uuid>` works | Wrong. Returns 0 results. |
| `completed=true/false` filter untested | Now confirmed working — 24,367 completed, 37,062 not. |
| Escrow office IDs are UUIDs | Wrong. Detail endpoint uses integer IDs (id=3). UUID on stubs doesn't resolve via detail endpoint. |
| Controls data has only operational noise | Wrong. Contains structured complaint tracking (post-QA data), full pricing context, and all property attribute captures. |

---

## 10. Schema additions required (v3.1.3 or migration-level)

Based on this audit, the following changes are needed:

### Must-add for migration completeness

| Field | Table | Type | Source | Priority |
|---|---|---|---|---|
| `gateCode` | `properties` | `varchar(50)` | `order.gatecode` | High |
| `costCenterName` | `inspections` | `varchar(100)` | `order.costcentername` | High |
| `referReasonText` | `inspections` | `varchar(200)` | Resolved from `/referreasons` | Medium |
| `reportNumber` | `inspections` | `varchar(50)` | `order.reportnumber` | High |
| `isnNotes` | `inspections.customFields` | jsonb key | `/order/notes/{id}` | Medium |
| `isnHistory` | `inspections.customFields` | jsonb key | `/order/history/{id}` | Low |
| `complaints` | `inspections.customFields` | jsonb key | Controls complaint fields | Medium |
| `isnControls` | `inspections.customFields` | jsonb key | Full controls array (non-bound types) | Low |

### Should-add for services model

| Field | Table | Type | Source | Priority |
|---|---|---|---|---|
| `sid` | `services` | `integer` | `/services.sid` | High |
| `ancillary` | `services` | `boolean` | `/services.ancillary` | High |
| `visibleToDispatcher` | `services` | `boolean` | `/services.visible` | Medium |
| `visibleOnlineBooking` | `services` | `boolean` | `/services.visible_order_form` | Medium |
| `isPac` | `services` | `boolean` | `/services.is_pac` | Low |
| `modifiers` | `services` | `jsonb` | `/services.modifiers` | Medium |
| `questions` | `services` | `jsonb` | `/services.questions` | Low |

### Does NOT need a schema change (migration-level only)

- Foundation type: read from `FoundationType` control value directly
- Order notes: store in `inspections.customFields.isnNotes`
- Order history: store in `inspections.customFields.isnHistory`
- Cost centers: store name string on inspections, skip a lookup table

---

## 11. Migration script changes required

| Script | Change | Priority |
|---|---|---|
| `migrate-orders.ts` | Always fetch with `?withallcontrols=true&withpropertyphoto=true` | **Critical** |
| `migrate-orders.ts` | Use `buyersagent` / `sellersagent` instead of ambiguous `agent` | **Critical** |
| `migrate-orders.ts` | Map `inspector1`–`inspector10` flat fields | **Critical** |
| `migrate-orders.ts` | Read foundation type from `FoundationType` control value | High |
| `migrate-orders.ts` | Populate `costCenterName`, `reportNumber`, `referReasonText` | High |
| `migrate-orders.ts` | Store order notes from `/order/notes/{id}` in `customFields.isnNotes` | Medium |
| `migrate-orders.ts` | Store complaint controls in `customFields.complaints` | Medium |
| `migrate-orders.ts` | Populate `gateCode` on property record | High |
| `migrate-services.ts` | Read full service shape from `/services` including `sid`, `ancillary`, etc. | High |
| `migrate-contacts.ts` | Already corrected in Phase 3 | Done |
| `seed.ts` | Seed `/referreasons` lookup into v3 | Medium |
| `seed.ts` | Seed `/costcenters` lookup into v3 | Low |

---

## 12. Final API surface map

**Documented endpoints: 61 paths, 87 operations**

**Confirmed working undocumented GET endpoints: 5**
- `/costcenters` — 2 cost center records
- `/referreasons` — 17 referral reasons
- `/services` — 20 service definitions (rich)
- `/fees` — 71 fee pricing rules
- `/order/notes/{id}` — order notes

**Confirmed broken documented endpoints: 6**
- `/insuranceagents` — status:error
- `/calendar/availableslots` — returns empty envelope
- `/orders?after=` — silently ignored
- `/orders?datetimeafter=` — returns 0
- `/orders/search?datetime=` — returns 0
- `/orders/search?reportnumber=` — returns 0
- `/orders/search?client=<uuid>` — returns 0
- `/users?uuids=` — returns full list (ignored)
- `/agencies?uuids=` — returns full list (ignored)

**Platform issues catalogued: 16 total (8 from prior phases, 3 from Phase 3, 3 from Phase 4)**
