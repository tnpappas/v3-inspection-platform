// Drizzle Kit config.
//
// - `generate` compiles schema.ts to SQL and does NOT need a live DB. It runs
//   fine with a placeholder URL.
// - `migrate` / `push` / `studio` connect to the DB and require a real URL.
//
// DATABASE_URL_UNPOOLED is provided by Doppler v3-migrations config in dev/stg/prd/ci.
// Use `doppler run -- pnpm drizzle:migrate` (etc.) when running anything that touches the DB.

import { defineConfig } from 'drizzle-kit';

const databaseUrl =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.DATABASE_URL ??
  'postgresql://placeholder:placeholder@localhost:5432/placeholder';

export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
