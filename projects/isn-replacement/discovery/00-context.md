# ISN Replacement, Working Context

_Captured 2026-04-25 from Troy._

## Current build state, not greenfield

- Replit project already exists and runs.
- Working URL: https://isn-killer.replit.app/
- Production URL: TBD.
- Infrastructure already in place:
  - Database pooling
  - OpenAI singleton
  - Structured logging
  - Parallelized API calls
- Troy will grant read access to the Replit project. Hatch must review existing code, schema, and built features before estimating or recommending. Do not assume greenfield.

## Discovery method

1. Screen share with Troy narrating. First pass on scheduling slice. Scheduled this week.
2. Direct crawl with login credentials. Field-by-field documentation pass.

## Data sources from ISN

- **API access** (Troy to provision). Endpoints confirmed available: inspections, clients, agreements, agents, reports, payments.
- **CSV exports** available from most screens.
- **No direct DB access.** ISN does not expose the database.

## Volume

- 2025 full year: **1,950 tickets** company-wide.
- Avg ~160 inspections/month, seasonal peaks spring and fall.
- Peak day load: **15 to 20 inspections**.
- Active inspectors: **8 to 12** (Troy to confirm exact).

## Scheduling surface as it stands today

- Primary: **office dispatcher** assigns manually.
- Secondary: realtor self-book via ISN realtor portal.
- Inspector self-scheduling: **not used**.
- Multi-inspector jobs: rare, mostly large commercial.
- Availability model: working hours and days off tracked. Drive time, buffer, max jobs/day are dispatcher judgment, not enforced. Service areas tracked but not used for auto-assignment.

### Schedule trigger sources, by volume

1. Phone call to office (dominant)
2. Realtor portal request
3. Web form
4. Email

(Exact splits not yet measured.)

## Hard day-one integrations

- Report writing tool (must keep current integration parity with ISN)
- Payment processor: **Stripe** target, current processor swappable
- Realtor portal for agent partners
- QuickBooks or general accounting export
- Email and SMS notifications, both client-facing and inspector-facing

## Keep, what ISN does well

- Realtor portal experience
- Agreement signing flow
- Day-of inspector workflow on mobile
- Automated client and realtor notifications
- Report delivery to client and realtor

## Cut, what ISN does that nobody uses

- Most marketing template features
- Most report customization beyond basics
- Several legacy integrations never enabled
- (Full cut list pending crawl)

## Cutover plan

- Scheduling slice in production for **one inspector**: 60 to 90 days from build start.
- Parallel-run with ISN until confident.
- Expand to all inspectors, then full cutover.
- Total ISN replacement: **6 to 9 months**.

## Open items Troy owes Hatch

- Replit read access (format TBD, see recommendation)
- ISN API credentials and rate limit info
- ISN login for direct crawl
- Confirmed active inspector count
- Schedule for first scheduling screen-share walkthrough this week
