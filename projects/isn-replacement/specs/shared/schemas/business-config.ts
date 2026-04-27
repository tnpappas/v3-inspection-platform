/**
 * Zod schema for businesses.config (jsonb column).
 *
 * Lives outside the main schema.ts file. Matches existing Replit project's
 * `shared/` pattern. `.passthrough()` allows additive evolution without breaking
 * existing rows.
 *
 * Imported by `01-schema.ts` for type-checking and by API routes that
 * mutate `businesses.config`.
 */

import { z } from "zod";

export const businessConfigSchema = z
  .object({
    // Default operating hours for the business. Per-technician hours override
    // these in `inspector_hours`.
    defaultHours: z
      .object({
        monday: z.object({ start: z.string(), end: z.string() }).optional(),
        tuesday: z.object({ start: z.string(), end: z.string() }).optional(),
        wednesday: z.object({ start: z.string(), end: z.string() }).optional(),
        thursday: z.object({ start: z.string(), end: z.string() }).optional(),
        friday: z.object({ start: z.string(), end: z.string() }).optional(),
        saturday: z.object({ start: z.string(), end: z.string() }).optional(),
        sunday: z.object({ start: z.string(), end: z.string() }).optional(),
      })
      .passthrough()
      .optional(),

    // Service-area defaults. Per-technician zip coverage in `inspector_zips`
    // takes precedence; this is the fallback for the business as a whole.
    serviceAreaDefault: z
      .object({
        zipCodes: z.array(z.string()).optional(),
        radiusMiles: z.number().int().nonnegative().optional(),
        baseLatLng: z
          .object({ lat: z.number(), lng: z.number() })
          .optional(),
      })
      .passthrough()
      .optional(),

    // Per-business notification routing.
    notifications: z
      .object({
        dispatchAlertsTo: z.array(z.string().email()).optional(),
        clientCommsFromAddress: z.string().email().optional(),
        smsFromNumber: z.string().optional(),
      })
      .passthrough()
      .optional(),

    // Integration toggles per business. Concrete credentials live in the
    // secrets store, never here.
    integrations: z
      .object({
        stripe: z.object({ enabled: z.boolean() }).passthrough().optional(),
        homeInspectorPro: z
          .object({ enabled: z.boolean() })
          .passthrough()
          .optional(),
        skimmer: z.object({ enabled: z.boolean() }).passthrough().optional(),
        fieldroutes: z
          .object({ enabled: z.boolean() })
          .passthrough()
          .optional(),
        quickbooks: z
          .object({ enabled: z.boolean() })
          .passthrough()
          .optional(),
        twilio: z.object({ enabled: z.boolean() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),

    // Defaults for inspections / pool jobs / pest treatments scheduling logic.
    schedulingDefaults: z
      .object({
        defaultDurationMinutes: z.number().int().positive().optional(),
        bufferMinutesBetweenJobs: z.number().int().nonnegative().optional(),
        maxJobsPerDayDefault: z.number().int().positive().optional(),
        driveTimeFactor: z.number().positive().optional(),
      })
      .passthrough()
      .optional(),

    // Feature flags scoped to this business only.
    features: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();

export type BusinessConfig = z.infer<typeof businessConfigSchema>;
