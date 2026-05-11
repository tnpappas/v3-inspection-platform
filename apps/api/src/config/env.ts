/**
 * Environment variable validation.
 *
 * All env vars are sourced from Doppler (project v3-api). Required vars are
 * marked as such; optional vars surface as `undefined` until their integration
 * is wired in a later week of Phase 1.
 *
 * Run via `doppler run -- pnpm dev` from apps/api/. `loadEnv()` throws at
 * startup with a readable error if anything is malformed.
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  // Database (week 1; Neon URL injected by Doppler v3-api config)
  DATABASE_URL: z.string().url().optional(),

  // Session (required when serving authenticated routes; default is dev-only)
  SESSION_SECRET: z
    .string()
    .min(32)
    .default('dev-only-please-rotate-via-doppler-before-prd'),

  // Integrations (each becomes required when its slice ships; optional until then)
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  INTUIT_CLIENT_ID: z.string().optional(),
  INTUIT_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

  // Observability
  SENTRY_DSN_API: z.string().url().optional(),

  // App-layer encryption keys
  MFA_ENCRYPTION_KEY: z.string().min(32).optional(),
  PUBLIC_BOOKING_TOKEN_SECRET: z.string().min(32).optional(),

  // Widget CORS allowlist (comma-separated origins)
  WIDGET_CORS_ORIGINS: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : [],
    ),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}
