# ISN API, Authentication and Base URL

_Confirmed working 2026-04-25._

## Base URL

```
https://inspectionsupport.net/safehouse/rest
```

Construction: `service_domain` + `company_key` + `rest`.

NOT `/api/v1/`. That path returns 401 regardless of credentials and appears to be a separate (possibly internal) surface.

## Authentication

HTTP Basic.

- Username = Access Key
- Password = Secret Access Key

Either `access_key/secret_access_key` OR a real ISN `username/password` will work. Keys preferred so the user can rotate without changing their login.

Credentials live in `~/.openclaw/secrets/isn.env`, mode 600, outside the workspace tree. Never echoed in logs or files.

## Response shape

- HTTP 200 even on logical errors. Always check the `status` field in the JSON body.
- Success: `{"status": "ok", ...}` plus payload keys.
- Error: `{"status": "error", "message": "..."}`.

## Confirmed endpoints

- `GET /rest` returns "missing or invalid action specified" when authenticated. Useful as a connectivity check.
- `GET /rest/orders/footprints` returns `{"status": "ok", "footprints": []}`.

## Footprint pattern, and our deviation from it

ISN's documented flow:

1. GET `/orders/footprints` to list hooks for upcoming inspections assigned to the API user.
2. GET `/order/{id}`, `/client/{id}`, `/agent/{id}` for details.
3. **DELETE the footprint after reading.** Footprints persist until deleted or ISN auto-purges.

We are read-only. **We will not DELETE footprints.** Operational impact: zero on Safe House, footprints simply linger until ISN purges them. Tactical impact: if we re-crawl the same user, we will see the same footprints again. Acceptable for discovery.

## Open questions for Troy

1. **Whose user generated the current keys?** Footprints scope to the API user. If these are an inspector's keys, the crawl sees only that inspector's upcoming jobs. For a full data extraction we likely need office or admin-tier keys.
2. Is there a documented endpoint for listing all orders/inspections at the company level (not just the user's footprints)? The OpenAPI explorer at `http://api.inspectionsupport.net/` (HTTP, not HTTPS) reportedly documents the full surface. Worth a separate session.

## Security note

The OpenAPI explorer is published over plain HTTP at `api.inspectionsupport.net`. Anyone testing endpoints there would transmit Basic auth in cleartext. We will only use the live tenant API (`inspectionsupport.net`) over HTTPS.
