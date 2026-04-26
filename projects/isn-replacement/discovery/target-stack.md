# Target Stack, ISN Replacement (isn-killer)

_Captured 2026-04-26. Source of truth for every spec under `projects/isn-replacement/specs/`._

The replacement is being built on Replit as a single Express process on port 5000. Vite serves the frontend in dev mode, the same Express server handles `/api/*` routes.

## Backend

| Layer | Choice |
|---|---|
| Runtime | Node.js (Replit-managed) |
| HTTP framework | Express.js |
| ORM | Drizzle ORM |
| Database | Postgres (Neon, via Replit) |
| Auth | Passport.js, local strategy, session cookies |
| Session store | `connect-pg-simple` (sessions in Postgres) |
| Transactional email | Resend |
| Email templates | Handlebars |

## Frontend

| Layer | Choice |
|---|---|
| Framework | React |
| Build/dev server | Vite |
| Routing | Wouter |
| Data fetching | TanStack Query v5 |
| UI components | shadcn/ui on Tailwind |
| Forms | React Hook Form + Zod |

## Shared

- `shared/` directory holds:
  - Drizzle schema definitions
  - TypeScript types used by both backend and frontend
- Schema deliverables for this project drop into this folder pattern.

## Infrastructure already built (per Troy)

- Database connection pooling
- OpenAI singleton
- Structured logging
- Parallelized API calls

## Constraints these introduce on every spec

- **Schema specs** are TypeScript using Drizzle's `pgTable` and live under `shared/`.
- **API specs** follow `/api/*` route convention, single Express server, Passport session cookies for auth.
- **Form validation** uses Zod schemas, shared between client and server where possible.
- **UI specs** call out specific shadcn/ui components by name.
- **Email specs** target Resend's send API and Handlebars template structure.
- **Realtime/jobs** are not yet stipulated. Open question for later slices.
