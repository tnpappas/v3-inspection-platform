// Drizzle Kit config. Reads DATABASE_URL_UNPOOLED from env (set by Doppler in dev/ci/prd).
// Schema source moves from projects/isn-replacement/specs/01-schema.ts to ./src/schema.ts on Day 2.

import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) must be set. Use `doppler run -- pnpm drizzle:generate`.');
}

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
