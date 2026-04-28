# Phase 3: All ISN GET Endpoints Crawled

_Run 2026-04-28. All 31 previously-uncrawled GET endpoints from the ISN OpenAPI spec. Every response field documented. PII redacted in this file; raw responses in `discovery/raw/phase3/` (gitignored)._

## Summary of findings

31 endpoints called, all HTTP 200. Key findings that affect specs and migration:

1. **Client detail field names differ from what spec 04 assumed.** ISN uses `first`/`last`/`display`/`workphone`/`homephone`/`mobilephone` — not `firstname`/`lastname`/`displayname`/`phonemobile`/`phonehome`/`phonework`. **Spec 04 field mapping needs correction.**
2. **Agent detail has new fields not seen before:** `tc` (transaction coordinator flag), `redactive`/`redurl` (referral active/URL), `labels`, `bio`, `lastactive`, `img` (photo URL key differs from user's `photourl`). `img` not `photourl`.
3. **Agency detail is materially richer than agents:** 20 fields including `logourl`, `active`, `lastactive`, `labels`, `notes`. Field names for phone differ from agent (`phone` not `workphone`).
4. **Contacts endpoint is unused.** `GET /contacts` returns count=0, contacts=[]. Not a data source.
5. **Escrow officer fields differ from agent:** uses `firstname`/`lastname` (like users) not `first`/`last` (like clients/agents). Also has `cellPhone` not `mobilephone`. Missing `agency` FK.
6. **Insurance agents endpoint returns status:error** (not status:ok). Entirely broken. Not a usable data source.
7. **Users search returns a richer stub:** `id`, `displayname`, `show`, `modified` — 4 fields vs the 3-field stub from `/users`.
8. **Orders search works but returns stubs.** `/orders/search?year=2026` returns 848 orders (all stubs). `/orders/search?address1=...` returns matching stubs. Neither returns detail.
9. **`/order/webdelivery/{id}` works.** Returns a URL pointing at `inspectionsupport.com/safehouse/report-delivery/{uuid}?pq=...`. Used for report delivery — relevant to the report delivery slice.
10. **Available slots always returns 0.** Troy's inspector user returns 0 slots across all parameter combinations (default, with service, with ZIP). Almost certainly because Troy's user has no `technician_hours` configured in ISN, or ISN requires different setup for the slots algorithm.
11. **`/calendar/availableslots` is broken differently.** Returns only `{status, message}` with no slot data, not even a count. Versus `/availableslots` which at least returns the metadata (count=0, daysahead, offset, etc.). These two are NOT aliases.

---

## Endpoint-by-endpoint documentation

### `/clients` (list)

**Response shape:**

```json
{
  "status": "ok",
  "count": 27709,
  "after": "na",
  "clients": [{ "id": "<UUID>", "show": "no", "modified": "..." }]
}
```

27,709 client records (stubs only — same pattern as agents). After filter broken (after=na returned). **Implications:** full client migration requires `GET /client/{id}` for each of 27,709 records at 400ms throttle = ~3 hours.

---

### `/clients/search?q=...`

Works. Returns stubs matching the search term. count=289 for "Smith". After field present (different from the `after=na` on the list endpoint).

---

### `/client/{id}`

**Full record shape (26 fields):**

| Field | ISN name | v3 mapping | Notes |
|---|---|---|---|
| `id` | `id` | `customers.isnSourceId` | |
| `first` | **`first`** | `customers.firstName` | **NOT `firstname`** — differs from users! |
| `last` | **`last`** | `customers.lastName` | **NOT `lastname`** |
| `display` | **`display`** | `customers.displayName` | **NOT `displayname`** |
| `email` | `email` | `customers.email` | **NOT `emailaddress`** — differs from users! |
| `workphone` | `workphone` | `customers.phoneWork` | **NOT `phonework`** |
| `homephone` | `homephone` | `customers.phoneHome` | **NOT `phonehome`** |
| `mobilephone` | `mobilephone` | `customers.phoneMobile` | **NOT `phonemobile`** |
| `mobilephone2` | `mobilephone2` | (drop) | Additional phone; rarely populated |
| `mobilephone3` | `mobilephone3` | (drop) | |
| `workfax` | `workfax` | (drop) | |
| `homefax` | `homefax` | (drop) | |
| `address1` | `address1` | `customers.address1` | |
| `address2` | `address2` | `customers.address2` | |
| `city` | `city` | `customers.city` | |
| `state` | `state` | (UUID, drop) | |
| `stateabbreviation` | `stateabbreviation` | `customers.state` | |
| `zip` | `zip` | `customers.zip` | |
| `companyname` | `companyname` | (drop or `notes`) | Rarely populated |
| `url` | `url` | (drop) | Client's website — not used |
| `notes` | `notes` | `customers.notes` | |
| `send_sms` | **`send_sms`** | `customers.smsOptIn` | **NOT `sendSMS`** — differs from users! |
| `send_email` | **`send_email`** | `customers.emailOptIn` | **NOT `sendemail`** |
| `porch` | `porch` | (drop) | ISN-specific field, unknown purpose |
| `modified` | `modified` | `customers.updatedAt` | |
| `show` | `show` | `customers.status` | |

**Critical finding:** ISN client field names are DIFFERENT from ISN user field names:
- Users: `firstname`, `lastname`, `displayname`, `emailaddress`, `sendSMS`
- Clients: `first`, `last`, `display`, `email`, `send_sms`

**Spec 04 `04-field-mapping.md` must be corrected.** The current mapping uses the wrong field names for clients.

---

### `/agencies` (list)

1,290 agencies (stubs: `id`, `show`, `modified`). after=na (same broken filter).

---

### `/agency/{id}`

**Full record shape (20 fields):**

| Field | ISN name | v3 mapping |
|---|---|---|
| `id` | `id` | `agencies.isnSourceId` |
| `name` | `name` | `agencies.name` |
| `display` | `display` | (same as name, drop duplicate) |
| `emailaddress` | `emailaddress` | `agencies.email` |
| `address1` | `address1` | `agencies.address` |
| `address2` | `address2` | (fold into address or drop) |
| `city` | `city` | `agencies.city` |
| `state` | `state` | (UUID, drop) |
| `stateabbreviation` | `stateabbreviation` | `agencies.state` |
| `zip` | `zip` | `agencies.zip` |
| `url` | `url` | (drop) |
| `phone` | **`phone`** | `agencies.phone` | Note: `phone` not `workphone` |
| `fax` | `fax` | (drop) |
| `show` | `show` | `agencies.active` |
| `modified` | `modified` | `agencies.updatedAt` |
| `logourl` | `logourl` | (not in v3 schema yet) |
| `active` | `active` | `agencies.active` (same as show, use active) |
| `lastactive` | `lastactive` | (drop) |
| `labels` | `labels` | (drop — ISN tagging) |
| `notes` | `notes` | `agencies.notes` |

**Notes:**
- Agency uses `emailaddress` (same as users), NOT `email` (like clients). Inconsistent within ISN.
- `logourl` is a new field not in the v3 agencies schema. Could add to `agencies.config` or drop. Low priority.

---

### `/agent/{id}`

**Full record shape (34 fields):**

Core fields already covered in phase 1. New fields not previously observed:

| Field | ISN name | v3 mapping |
|---|---|---|
| `bio` | `bio` | `transaction_participants.notes` or drop |
| `img` | **`img`** | `transaction_participants` (photo) | Note: `img` not `photourl` — DIFFERENT from users! |
| `tc` | `tc` | **NEW** — indicates if this agent also serves as TC |
| `redactive` | `redactive` | (drop) — referral tracking |
| `redurl` | `redurl` | (drop) — referral URL |
| `labels` | `labels` | (drop) |
| `lastactive` | `lastactive` | (drop) |
| `latitude` | `latitude` | (drop at participant level) |
| `longitude` | `longitude` | (drop at participant level) |
| `sendsms` | **`sendsms`** | `transaction_participants.smsOptIn` | Note: not `send_sms` (clients) or `sendSMS` (users)! |
| `sendemail` | **`sendemail`** | `transaction_participants.emailOptIn` |

**Critical finding:** ISN uses THREE different field names for the SMS opt-in across entity types:
- Users: `sendSMS`
- Clients: `send_sms`
- Agents: `sendsms`

The migration helper `coerceIsnBoolean()` handles the value coercion, but `migrate-contacts.ts` must use the correct field name per entity type. **`migrate-contacts.ts` must be updated to read `a.sendsms` for agents, not `a.sendSMS` or `a.send_sms`.**

The `tc` flag (boolean: does this agent also serve as transaction coordinator?) is a useful hint for `transaction_participants.primaryRole` post-pass derivation. If `tc=true`, the agent sometimes acts as TC.

---

### `/contacts` — UNUSED

`GET /contacts` returns count=0. The generic "contacts" entity type exists in ISN's data model but Safe House has no records in it. **Confirmed: not a data source for migration.**

---

### `/escrowofficers` list

53 escrow officers in the system (stubs: `id`, `show`). Note: stubs here have only `id` and `show`, no `modified`. Different stub format from agents.

---

### `/escrowofficer/{id}`

**Full record shape (16 fields):**

| Field | ISN name | v3 mapping |
|---|---|---|
| `id` | `id` | `transaction_participants.isnSourceId` |
| `office` | `office` | (UUID, drop — not the same as business) |
| `firstname` | `firstname` | `transaction_participants.firstName` | Note: `firstname` not `first` (unlike clients) |
| `lastname` | `lastname` | `transaction_participants.lastName` |
| `displayname` | `displayname` | `transaction_participants.displayName` |
| `email` | `email` | `transaction_participants.email` |
| `url` | `url` | (drop) |
| `address1`–`zip` | as above | (drop; escrow officers don't need address in v3) |
| `phone` | `phone` | `transaction_participants.phone` |
| `fax` | `fax` | (drop) |
| `cellPhone` | **`cellPhone`** | `transaction_participants.mobile` | Note: capitalized, different from all others |

**Finding:** Escrow officer field names match users (`firstname`, `displayname`) NOT clients (`first`, `display`). No `agency` FK on escrow officers — they are standalone.

---

### `/escrowoffices` — 18 records (offices, not officers)

Separate from escrow OFFICERS. Escrow offices are the firms; escrow officers are the individuals. 18 offices in the system. Could serve as agency records for escrow firms if needed. Currently dropped.

---

### `/insuranceagents` — BROKEN

```json
{"status": "error", "message": "missing or invalid action specified"}
```

The endpoint returns status:error even though ISN API accepts the call. This endpoint is broken in the ISN API. **Confirmed: not a data source.** Safe House has 0 insurance agents (per phase 1 findings). This is consistent with the broken endpoint.

---

### `/users/search?q=...`

Returns a 4-field stub: `id`, `displayname`, `show`, `modified`. Richer than the 3-field `/users` list stub (adds `displayname`). Useful for migration-time user lookups by name.

---

### `/orders/search`

- `?year=2026` — 848 stubs (working)
- `?address1=N+Sixth` — 1 stub (working, exact text match)
- Returns stubs only (3 fields), same as the list endpoint

**Implication:** `orders/search` is the closest ISN has to a filtered list, but still returns stubs. Useful in migration prep for quickly finding test cases by year or address without pulling the full 61k list.

---

### `/order/webdelivery/{id}`

Returns:

```json
{"status": "ok", "url": "https://inspectionsupport.com/safehouse/report-delivery/<UUID>?pq=<token>", "message": ""}
```

URL points at `inspectionsupport.com` (the broken redirect host). The token (`pq=...`) appears to be a signed access token for the report. **Relevant to the report delivery slice:**

- ISN hosts reports at `v3.isnbin.com` (separate CDN, same as user photos)
- `report-delivery` URL is time-limited (token in `pq` parameter)
- For migration: fetch and re-host reports before ISN access expires

---

### `/availableslots` vs `/calendar/availableslots`

**NOT aliases.** These are different endpoints with different behavior:

`/availableslots?inspector=<UUID>&daysahead=14&offset=0`:

```json
{
  "status": "ok",
  "count": 0,
  "zip": null,
  "daysahead": 14,
  "offset": 0,
  "services": null,
  "slots": []
}
```

Returns the full metadata envelope even with 0 slots. `slots` is an array (currently empty for Troy's user).

`/calendar/availableslots?inspector=<UUID>&daysahead=14&offset=0`:

```json
{"status": "ok", "message": ""}
```

Returns only status + message. No envelope, no count, no slots array. **Broken or requires different setup.** Platform issue to log.

**Zero slots finding:** Troy's inspector user returns 0 slots on both endpoints. Likely because ISN requires technician hours/availability to be explicitly configured before the slot algorithm runs. Since ISN's slot computation worked for scheduling in the past, Troy likely never configured it in ISN (relying on the dispatcher's manual approach). **This confirms the migration plan's assumption that ISN's availability model is unused — the `technician_hours` data does not exist to migrate.**

---

## Impact on specs and migration

### Spec 04 corrections required (field names differ from assumed)

The current `04-field-mapping.md` uses field names inferred from order-embedded references, which are UUIDs not full records. The actual full-record field names differ:

| Entity | Field in spec 04 | Actual ISN field | Correction needed |
|---|---|---|---|
| Client | `firstname` | `first` | Update mapping |
| Client | `lastname` | `last` | Update mapping |
| Client | `displayname` | `display` | Update mapping |
| Client | `emailaddress` | `email` | Update mapping |
| Client | `phonemobile` | `mobilephone` | Update mapping |
| Client | `phonehome` | `homephone` | Update mapping |
| Client | `phonework` | `workphone` | Update mapping |
| Client | `sendSMS` | `send_sms` | Update mapping |
| Agent | `photourl` | `img` | Update mapping |
| Agent | `sendemail` | `sendemail` | Unchanged — agent matches |
| Agent | `sendSMS` | `sendsms` (lowercase) | Update mapping — agent uses `sendsms` |

### Migration script corrections required

**`migrate-contacts.ts` needs updates:**

For the client import block:
```ts
// WRONG (from spec 04 inference):
email: normalizeIsnString(c.emailaddress),
firstName: normalizeIsnString(c.firstname),
phoneMobile: normalizeIsnString(c.phonemobile),

// CORRECT (confirmed from /client/{id}):
email: normalizeIsnString(c.email),
firstName: normalizeIsnString(c.first),
phoneMobile: normalizeIsnString(c.mobilephone),
homePhone: normalizeIsnString(c.homephone),
phoneWork: normalizeIsnString(c.workphone),
smsOptIn: coerceIsnBoolean(c.send_sms),  // not sendSMS
emailOptIn: coerceIsnBoolean(c.send_email),  // not sendemail
```

For the agent import block:
```ts
smsOptIn: coerceIsnBoolean(a.sendsms),     // agents use 'sendsms'
photoUrl: normalizeIsnString(a.img),        // agents use 'img'
```

For the escrow officer import block:
```ts
mobile: normalizeIsnString(eo.cellPhone),   // note: capital P
```

### v3 schema gaps surfaced

Minor; nothing that requires a schema version bump:

1. `agencies` schema has no `logoUrl` column. ISN agencies have `logourl`. Low priority; could add to `agencies.config` if needed.
2. `transaction_participants` schema has no `tc` flag to reflect ISN's `tc` boolean on agents. The `primaryRole` post-pass already handles this; `tc=true` agents get `transaction_coordinator` added to their role distribution.

### Platform issues to add

**Platform issue #10:** `/insuranceagents` endpoint returns `status:error`. The API accepts the call (HTTP 200) but the response indicates the action is not recognized. The endpoint is published in the OpenAPI spec but broken in production.

**Platform issue #11:** `/calendar/availableslots` returns only `{status, message}` — no slot envelope, no count. `/availableslots` returns the full envelope (with empty `slots` array). These endpoints have identical parameters in the spec but different behavior in production. They are NOT aliases.

---

## New data confirmed from this crawl

| Entity | ISN count | Migration impact |
|---|---|---|
| Clients | 27,709 | ~3 hours API time for full crawl at 400ms throttle |
| Agencies | 1,290 | ~9 minutes for full agency detail crawl |
| Escrow officers | 53 | Trivial |
| Escrow offices | 18 | Trivial; note: different from officers |
| Insurance agents | 0 / broken | Skip; endpoint broken |
| Contacts (generic) | 0 | Skip; unused |
| Orders in 2026 (search) | 848 | Useful for test-case extraction during migration prep |
