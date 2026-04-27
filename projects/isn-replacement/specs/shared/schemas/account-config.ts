/**
 * Zod schema for accounts.config (jsonb column).
 *
 * Lives outside the main schema.ts file so the type and the table can be imported
 * separately if needed. Matches the existing Replit project's `shared/` pattern.
 *
 * `.passthrough()` is intentional: we document expected keys here, but accept
 * additional keys without rejection. New config entries land in callers first
 * and get codified here over time.
 *
 * Imported by `01-schema.ts` for type-checking on read paths and by API
 * routes that mutate `accounts.config`.
 */

import { z } from "zod";

export const accountConfigSchema = z
  .object({
    // Branding overrides for the account-level UI shell. Per-business branding
    // lives on `businesses` (logoUrl, primaryColor). This is the licensee-level
    // wrapper.
    branding: z
      .object({
        productName: z.string().max(100).optional(),
        supportEmail: z.string().email().optional(),
        supportPhone: z.string().max(50).optional(),
        accentColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/, "must be hex like #0F172A")
          .optional(),
      })
      .passthrough()
      .optional(),

    // Licensing tier metadata. Drives feature gating in the future.
    // plan_tier on the `accounts` table is the primary signal; this is for
    // licensing-flow-specific extras.
    licensing: z
      .object({
        contractStartDate: z.string().optional(),
        contractEndDate: z.string().optional(),
        seatLimit: z.number().int().nonnegative().optional(),
        businessLimit: z.number().int().nonnegative().optional(),
        inspectionsPerMonthCap: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),

    // Notification routing for account-level events (billing, plan changes,
    // limits exceeded). Per-business notifications live on `businesses.config`.
    notifications: z
      .object({
        billingAlertsTo: z.array(z.string().email()).optional(),
        usageAlertsTo: z.array(z.string().email()).optional(),
      })
      .passthrough()
      .optional(),

    // Feature flags scoped to the entire account. Per-business flags live on
    // `businesses.config`.
    features: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

export type AccountConfig = z.infer<typeof accountConfigSchema>;
