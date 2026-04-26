# Phase 0 Results, ISN Crawl

_Run 2026-04-26T18:23 UTC. 4 calls, 4 successes. Awaiting Troy's approval to proceed to Phase 1._

## Calls

| # | Method | Path | HTTP | Status | Bytes |
|---|---|---|---|---|---|
| 0.1 | GET | `/me` | 200 | ok | 2,778 |
| 0.2 | GET | `/companykey` | 200 | ok | 53 |
| 0.3 | GET | `/build` | 200 | ok | 43 |
| 0.4 | GET | `/time` | 200 | ok | 106 |

Raw responses saved to `discovery/raw/phase0/` (gitignored).

## Findings

### Authenticated identity confirmed

`/me` returned Troy Pappas, owner role, Safe House office at 2128 London Bridge Rd, Virginia Beach 23456. `inspector: Yes`, `owner: Yes`, `manager: No`. The keys carry the broadest available access. `ipaccesskey` and `ipsecretkey` are null, meaning no IP allowlist is enforced on these credentials.

### Company key matches

`/companykey` returns `"safehouse"`. URL slug and tenant agree.

### Build version

`8553`. The OpenAPI spec we pulled was version `8400`. Production is **153 builds ahead of the spec**. Worth flagging: the published spec is stale relative to live. Endpoints, fields, or behaviors may exist in production that are not in the spec, and vice versa. We will discover differences as we crawl.

### Server time and timezone signal

ISN reports `time` in UTC and `client` in `-07:00`. The "client" clock is Pacific. ISN is a Pacific-time company, our data lives in Eastern. Not a problem, but every datetime we ingest needs explicit timezone handling, not naive parse.

### Data shape signals from `/me`

The user object foreshadows the `users` table for the rebuild:

- All fields are returned as strings, including booleans (`"Yes"`, `"No"`, `"true"`). The API does not use real JSON booleans for these. Our Drizzle schema will need to coerce.
- Role flags are five separate string fields (`inspector`, `owner`, `manager`, `officestaff`, `callcenter`, `thirdparty`), not a single role enum. ISN supports overlapping roles per user. The rebuild needs to model this as bitflags or a junction table, not a single role column.
- `state` is returned as a UUID, not a state code. ISN normalizes states to a reference table. The rebuild will likely use the abbreviation directly (`stateabbreviation: "VA"`) and skip the join.
- `zips` is an array of 72 ZIP codes attached to the user. This is the inspector service area model. **This is the core territory data we need for routing and slot assignment.** ISN tracks it but does not enforce it during scheduling per Troy's input. The rebuild can do better.
- `photourl` points to `v3.isnbin.com`. ISN hosts user photos on a separate binary CDN. We will replicate with our own asset host.
- `sendSMS: "true"` means user opt-in to SMS is per-user. Carries over.
- `modified` timestamp is present on the user. Confirms `after=` filtering on `/users` will work.

## Spec quirks to log

**New entry for `isn-platform-issues.md`:**

- Spec version `8400`, production build `8553`. The published spec lags production by 153 builds. Field 5 in our platform-issues catalog.

I will append this to `isn-platform-issues.md` as part of Phase 1 prep.

## Pipeline confirmation

- Auth scheme works: HTTP Basic with access key as user, secret as password.
- Base URL works: `https://inspectionsupport.net/safehouse/rest`.
- Response shape consistent: `{ "status": "ok" | "error", ... }`, HTTP 200 even on logical errors.
- Local artifact storage works, gitignored.
- Throttle (300ms between calls) holding fine, no errors, no rate-limit signals.

## Recommendation

Proceed to Phase 1 (5 calls: `/offices`, `/users`, `/ordertypes/`, `/contacttypes/`, `/agents`).

I will pause again with Phase 1 results before touching `/orders` in Phase 2, since that is where real client PII enters the picture.

## CSV pipeline status

CSV exports from the ISN UI are not in my hands. I cannot pull these via API. Troy: when you have a chance, export at least these from the ISN admin UI and drop them into `discovery/csv/`:

- Inspectors / Users
- Order types / services
- Agents
- Recent orders (last 30 days)

The CSV-vs-API divergence check runs once those land. This is on you, not me.
