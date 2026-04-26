# External Integrations, Day-One Required

_Captured 2026-04-26._

These integrations must be in place at cutover, parity with ISN's current behavior is the floor.

## Report writing tool

**Home Inspector Pro (HIP).**

- Current ISN integration scope is unknown until we crawl the agreement/report slice. Likely vectors:
  - Report URL field set on the order and surfaced to client/realtor.
  - File upload / web delivery URL via `PUT /orders/uploadreport` and `PUT /orders/addreporturl` (write endpoints we will not call, but the existence of these in ISN's API hints at the integration shape).
- Action item before report-delivery slice begins: catalog HIP's outbound webhooks or API for delivering finished reports to our system.

## Payment processor

- **Stripe** is the target.
- Current ISN processor is swappable. We do not need to preserve it.

## Realtor portal

- Agent partners log in to a portal to view their inspections, request schedules, see reports.
- Day-one functional parity required (login, view, request schedule, see report).

## Accounting

- **QuickBooks** export, or a generalized CSV/Journal export that QuickBooks can ingest.
- Frequency and granularity TBD. Likely per-order revenue with fee breakdown.

## Notifications

- **Email:** Resend (already in the Replit stack, see `target-stack.md`).
- **SMS:** Provider TBD. Twilio is the default candidate, alternatives open. Required day-one.
- Both channels need client-facing and inspector-facing flows.

## Out of scope for the scheduling slice

These exist on the file but are not crawled or specified yet:

- Agreement signing flow
- Payment intake
- Report delivery mechanics beyond the link itself
- QuickBooks export
- Marketing/lead-source tracking
