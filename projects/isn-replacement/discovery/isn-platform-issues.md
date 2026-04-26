# ISN Platform Issues

_Catalog of basic API hygiene failures observed on the ISN platform during discovery. Material for the rebuild justification doc._

_First entries logged 2026-04-25._

## 1. Published OpenAPI spec advertises a broken server URL

The spec at `https://api.inspectionsupport.net/swagger/isn.json` declares its server as:

```
https://inspectionsupport.com/{companyKey}/rest
```

That host **301 redirects every request to `http://www.inspectionsupport.com`** (HTTP, marketing site), which then returns a WordPress 404. The actual working API is on `inspectionsupport.net`, not `.com`.

ISN ships an OpenAPI spec where the `servers` field is wrong. Any developer who follows the published doc literally will fail on call one and have no clear signal why.

The redirect also drops HTTPS, which would expose Basic auth credentials in cleartext if a client followed it.

## 2. Owner-only `all=true` flag on `/orders/footprints` is undocumented

`GET /orders/footprints?all=true` returns footprints across all inspectors. The spec describes it as:

> "return a list of footprints which include all inspectors. Only users who can ..."

The description is truncated mid-sentence in the spec itself. There is no separate documentation of the permission boundary. The owner-only behavior is something you discover by trial.

## 3. Duplicate endpoints with identical signatures

The spec defines both:

- `GET /availableslots`
- `GET /calendar/availableslots`

Both have the same parameters (`inspector`, `daysahead`, `offset`, `services`, `zip`) and the same summary ("Obtain all available slots"). No indication which is canonical, deprecated, or whether they differ in behavior. Sloppy surface design or an undocumented migration in flight.

## 4. Path parameters that are actually query parameters

`GET /order/{id}` declares `withallcontrols` and `withpropertyphoto` as `in: path` parameters. Path parameters by definition appear in the URL path, e.g., `/order/{id}/{withallcontrols}/{withpropertyphoto}`. There is only one path slot, `{id}`. These are query parameters mistyped as path parameters in the spec.

A doc bug at the spec level means generated client SDKs break or generate nonsense URLs.

## 5. Published spec lags production by 153 builds

Observed during Phase 0 of the crawl on 2026-04-26:

- OpenAPI spec at `https://api.inspectionsupport.net/swagger/isn.json` reports `info.version: "8400"`.
- Live production tenant `/build` returns `"8553"`.

Production is **153 builds ahead** of what ISN publishes as their API documentation. Anything added, removed, or changed in those 153 builds is invisible to integrators relying on the doc. Combined with item 1 (broken server URL in the spec), the published documentation is unreliable as a contract.

## 6. Bulk list endpoints return undocumented "stub" records

Observed during Phase 1 on `/agents`:

- Response contained 8,934 agent records.
- Each record had only three fields: `id`, `show`, `modified`.
- Real agent fields (name, email, phone, agency) require a separate call to `GET /agent/{id}` per record.

The OpenAPI spec implies `/agents` returns the full agent shape (referenced via the `Agent` schema in `definitions`). It does not. The stub form is not announced anywhere in the spec or response payload.

Integrator impact: anyone planning a crawl based on the spec underestimates call count by orders of magnitude. We hit this on the first list endpoint we tried.

## 7. Production response fields not declared in the spec

The `/agents` response included `count` and `after` keys at the top level. Neither is in the OpenAPI spec. The `after` value of `"na"` (rather than null or omitted) hints at an incremental-sync pattern that production supports but the documentation does not describe.

This is the inverse of issue #5: production has features the spec does not document, in addition to the spec describing things production no longer matches.

---

## Why this matters for the rebuild

A vendor charging >$12K/year, raising fees, ignoring improvement requests, and quietly courting our client data is also publishing API documentation with wrong server URLs, truncated descriptions, duplicate endpoints, and parameter-location bugs. Four basic hygiene failures discovered in the first hour of looking. This is not a platform with a quality bar.

We add observations here as we find them.
