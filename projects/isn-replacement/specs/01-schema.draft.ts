/**
 * 01-schema.draft.ts
 *
 * STATUS: DRAFT, awaiting Troy's review. Do not import. Do not migrate.
 *
 * Source of truth:
 * - Existing Replit project: ../replit-snapshot/shared/schema.ts (reuse where possible)
 * - ISN OpenAPI spec:        ../discovery/isn-openapi.json
 * - Phase 0 results:         ../discovery/03-phase0-results.md
 * - Phase 1 results:         ../discovery/04-phase1-results.md
 * - Existing Replit state:   ../discovery/existing-replit-state.md
 * - Design decisions:        ../decisions/2026-04-26-design-decisions.md
 *
 * Conventions:
 * - All TS strict.
 * - Drizzle pgTable + drizzle-zod insert schemas.
 * - Column comments include the ISN source field where one exists ("ISN: <field>").
 * - "NEW" tag on fields the rebuild adds that ISN does not surface.
 * - Decisions D1 (role overlap), D2 (pagination), D3 (timestamptz) applied.
 * - Gaps are marked "// GAP:" inline. Fill from Phase 2 + 3 results before locking.
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  decimal,
  jsonb,
  uuid,
  bigint,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// =============================================================================
// Reference: roles
// =============================================================================
// D1 decision: roles are a junction. No role enum on users.
// Canonical role list, expand with care.
export const ROLES = [
  "owner",
  "operations_manager",
  "inspector",
  "dispatcher",
  "client_success",
  "viewer",
] as const;

export type Role = (typeof ROLES)[number];

// Priority order for the derived "primary role" UI affordance (lower index = higher priority).
export const ROLE_PRIORITY: Role[] = [
  "owner",
  "operations_manager",
  "dispatcher",
  "inspector",
  "client_success",
  "viewer",
];

// =============================================================================
// offices
// =============================================================================
// ISN models offices as first-class. Existing Replit project does not (single
// company_settings row). Adding offices for forward compatibility, even though
// Safe House is single-office today. Cheap to add, expensive to retrofit.
export const offices = pgTable("offices", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 255 }).notNull(),                 // ISN: name
  slug: varchar("slug", { length: 100 }).notNull().unique(),        // ISN: slug
  address: text("address"),                                          // ISN: address
  city: varchar("city", { length: 100 }),                            // ISN: city (normalize trailing whitespace on import)
  state: varchar("state", { length: 2 }),                            // ISN: stateabbreviation (we skip ISN's state-UUID join)
  zip: varchar("zip", { length: 20 }),                               // ISN: zip
  county: varchar("county", { length: 100 }),                        // ISN: county
  latitude: decimal("latitude", { precision: 9, scale: 6 }),         // ISN: latitude
  longitude: decimal("longitude", { precision: 9, scale: 6 }),       // ISN: longitude
  managerName: varchar("manager_name", { length: 255 }),             // ISN: manager
  managerEmail: varchar("manager_email", { length: 255 }),           // ISN: manageremail (trim on import)
  phone: varchar("phone", { length: 50 }),                           // ISN: phone
  fax: varchar("fax", { length: 50 }),                               // ISN: fax
  url: varchar("url", { length: 255 }),                              // ISN: url
  active: boolean("active").default(true).notNull(),                 // ISN: show (boolean coerced from "yes"/"no")
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// =============================================================================
// users (internal team)
// =============================================================================
// Internal team only. Clients and realtors live in `contacts`.
// D1: role(s) live in user_roles, NOT here. We keep an optional cached
// `primary_role` for fast UI rendering, computed from user_roles + ROLE_PRIORITY.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  officeId: uuid("office_id").references(() => offices.id),          // ISN: office
  email: varchar("email", { length: 255 }).notNull().unique(),       // ISN: emailaddress
  username: varchar("username", { length: 100 }).unique(),           // ISN: username (kept for migration mapping; rebuild auth uses email)
  passwordHash: varchar("password_hash", { length: 255 }),
  firstName: varchar("first_name", { length: 100 }),                 // ISN: firstname
  lastName: varchar("last_name", { length: 100 }),                   // ISN: lastname
  displayName: varchar("display_name", { length: 200 }).notNull(),   // ISN: displayname (fallback to "{first} {last}" on import)
  phone: varchar("phone", { length: 50 }),                           // ISN: phone
  mobile: varchar("mobile", { length: 50 }),                         // ISN: mobile
  fax: varchar("fax", { length: 50 }),                               // ISN: fax
  address1: text("address1"),                                        // ISN: address1
  address2: text("address2"),                                        // ISN: address2
  city: varchar("city", { length: 100 }),                            // ISN: city
  state: varchar("state", { length: 2 }),                            // ISN: stateabbreviation
  zip: varchar("zip", { length: 20 }),                               // ISN: zip
  county: varchar("county", { length: 100 }),                        // ISN: county
  license: varchar("license", { length: 100 }),                      // ISN: license
  licenseType: varchar("license_type", { length: 100 }),             // ISN: licensetype
  bio: text("bio"),                                                  // ISN: bio
  photoUrl: varchar("photo_url", { length: 500 }),                   // ISN: photourl (rehosted on our asset host on migration)
  smsOptIn: boolean("sms_opt_in").default(false).notNull(),          // ISN: sendSMS (coerced)
  primaryRole: varchar("primary_role", { length: 50 }),              // NEW (cached, computed from user_roles by ROLE_PRIORITY)
  status: varchar("status", { length: 50 }).default("active").notNull(), // active | inactive | invited (replaces ISN's "show" Yes/No)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byOffice: index("users_office_id_idx").on(t.officeId),
  byStatus: index("users_status_idx").on(t.status),
}));

// =============================================================================
// user_roles (D1 junction table)
// =============================================================================
export const userRoles = pgTable("user_roles", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 50 }).notNull(),                   // one of ROLES
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  grantedBy: uuid("granted_by").references(() => users.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.role] }),
  byRole: index("user_roles_role_idx").on(t.role),
}));

// =============================================================================
// inspector availability
// =============================================================================
// NEW. ISN tracks loosely; we model explicitly. Three pieces:
//   1. Recurring weekly hours per inspector
//   2. Time-off windows
//   3. ZIP coverage
// Fed into the new /api/calendar/availableslots endpoint for slot computation.

// 1. Recurring weekly hours
export const inspectorHours = pgTable("inspector_hours", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inspectorId: uuid("inspector_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // 0 = Sunday ... 6 = Saturday (matches JS Date.getDay())
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: varchar("start_time", { length: 5 }).notNull(),         // "HH:MM" 24h, store as text to skip tz issues for time-of-day
  endTime: varchar("end_time", { length: 5 }).notNull(),             // "HH:MM"
  effectiveFrom: timestamp("effective_from", { withTimezone: true }), // null = always
  effectiveTo: timestamp("effective_to", { withTimezone: true }),    // null = forever
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byInspector: index("inspector_hours_inspector_idx").on(t.inspectorId),
}));

// 2. Time-off windows
export const inspectorTimeOff = pgTable("inspector_time_off", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inspectorId: uuid("inspector_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byInspector: index("inspector_time_off_inspector_idx").on(t.inspectorId),
  byWindow: index("inspector_time_off_window_idx").on(t.startsAt, t.endsAt),
}));

// 3. ZIP coverage
// ISN attaches a flat ZIP array to the user. We split it out so we can index it.
export const inspectorZips = pgTable("inspector_zips", {
  inspectorId: uuid("inspector_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  zip: varchar("zip", { length: 20 }).notNull(),
  // Optional priority (1 = primary, 5 = will-go-if-needed). Lets the slot algo prefer
  // primary territory before bleeding into edges. Defaults to 1 on migration.
  priority: integer("priority").default(1).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.inspectorId, t.zip] }),
  byZip: index("inspector_zips_zip_idx").on(t.zip),
}));

// =============================================================================
// services (replaces ISN ordertypes)
// =============================================================================
// ISN's /ordertypes/ has no duration. We add it here, with optional per-inspector
// override below. Decision: duration lives on the service by default, inspector
// can override per-service via inspector_service_durations.
export const services = pgTable("services", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  officeId: uuid("office_id").references(() => offices.id),          // ISN: office
  name: varchar("name", { length: 255 }).notNull(),                  // ISN: name
  description: text("description"),                                  // ISN: description (internal)
  publicDescription: text("public_description"),                     // ISN: publicdescription (client-facing)
  baseFee: decimal("base_fee", { precision: 10, scale: 2 }).notNull(),
  defaultDurationMinutes: integer("default_duration_minutes").notNull().default(180), // NEW
  sequence: integer("sequence").default(100).notNull(),              // ISN: sequence (display order)
  active: boolean("active").default(true).notNull(),                 // ISN: show (coerced)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byOffice: index("services_office_idx").on(t.officeId),
  byActive: index("services_active_idx").on(t.active),
}));

// Per-inspector duration override. Optional. When absent, fall back to
// services.defaultDurationMinutes.
export const inspectorServiceDurations = pgTable("inspector_service_durations", {
  inspectorId: uuid("inspector_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  durationMinutes: integer("duration_minutes").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.inspectorId, t.serviceId] }),
}));

// =============================================================================
// agencies (NEW vs existing Replit project)
// =============================================================================
// ISN has ~9000 agents organized by agency. The existing Replit schema makes
// agency a free-text "company" field on contacts. That's lossy. Real agencies
// support: bulk realtor comms, agency-level reporting, brokerage relationships.
export const agencies = pgTable("agencies", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 2 }),
  zip: varchar("zip", { length: 20 }),
  notes: text("notes"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byNameLower: index("agencies_name_lower_idx").on(sql`lower(${t.name})`),
}));

// =============================================================================
// contacts (clients + agents + escrow + insurance + TC, all unified)
// =============================================================================
// ISN models clients, agents, escrowofficers, insuranceagents as separate
// resource types. We unify on `contacts` with a `type` discriminator, matching
// the existing Replit pattern. The mapping doc captures cross-type fields.
//
// GAP: Phase 2 will reveal whether ISN's order references real estate agents
// directly by ID, vs by separate buyer_agent / listing_agent foreign keys.
// The schema below assumes the existing Replit pattern of separate FKs on the
// inspection (buyerAgentId, listingAgentId).
export const CONTACT_TYPES = [
  "client",
  "buyer_agent",
  "listing_agent",
  "transaction_coordinator",
  "escrow_officer",
  "insurance_agent",
  "seller",
  "other",
] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  type: varchar("type", { length: 50 }).notNull(),                   // CONTACT_TYPES
  agencyId: uuid("agency_id").references(() => agencies.id),         // realtors only; null otherwise
  firstName: varchar("first_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  email: varchar("email", { length: 255 }),                          // not unique; same person can be in twice with different types
  phone: varchar("phone", { length: 50 }),
  mobile: varchar("mobile", { length: 50 }),
  address1: text("address1"),
  address2: text("address2"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 2 }),
  zip: varchar("zip", { length: 20 }),
  notes: text("notes"),
  // Source-of-truth tracking for migration and dedupe
  isnSourceId: uuid("isn_source_id").unique(),                       // ISN: id (preserved through migration)
  isnSourceType: varchar("isn_source_type", { length: 50 }),         // "client" | "agent" | "escrowofficer" | "insuranceagent"
  smsOptIn: boolean("sms_opt_in").default(false).notNull(),
  emailOptIn: boolean("email_opt_in").default(true).notNull(),
  status: varchar("status", { length: 50 }).default("active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byType: index("contacts_type_idx").on(t.type),
  byEmail: index("contacts_email_idx").on(t.email),
  byAgency: index("contacts_agency_idx").on(t.agencyId),
  byIsnSource: uniqueIndex("contacts_isn_source_idx").on(t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
}));

// =============================================================================
// inspections (replaces ISN orders)
// =============================================================================
// D3 applied: scheduled_at timestamptz + duration_minutes. No date+time split.
// Multi-axis status retained from existing Replit project.
//
// GAP: many ISN order fields are unknown until Phase 2 detail crawl. Marked
// inline. Fill before locking.
export const inspections = pgTable("inspections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  officeId: uuid("office_id").references(() => offices.id).notNull(),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(), // SH-YYYY-NNNN

  // Source tracking
  isnSourceId: uuid("isn_source_id").unique(),                       // ISN: id
  isnReportNumber: varchar("isn_report_number", { length: 50 }),     // ISN: reportnumber

  // Scheduling
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(), // D3
  durationMinutes: integer("duration_minutes").notNull().default(180),
  // Generated end timestamp for fast overlap queries.
  // GAP: Drizzle's generated-column support varies. If unsupported in this Drizzle version, compute in queries.
  // scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true }).generatedAlwaysAs(sql`scheduled_at + (duration_minutes || ' minutes')::interval`),

  inspectorId: uuid("inspector_id").references(() => users.id),
  // Multi-inspector support (rare per Troy, but does happen on commercial). Junction table.

  // People
  clientId: uuid("client_id").references(() => contacts.id),
  buyerAgentId: uuid("buyer_agent_id").references(() => contacts.id),
  listingAgentId: uuid("listing_agent_id").references(() => contacts.id),
  transactionCoordinatorId: uuid("transaction_coordinator_id").references(() => contacts.id),

  // Property
  propertyAddress: text("property_address").notNull(),
  propertyCity: varchar("property_city", { length: 100 }),
  propertyState: varchar("property_state", { length: 2 }),
  propertyZip: varchar("property_zip", { length: 20 }),
  propertyYearBuilt: integer("property_year_built"),                 // ISN: GAP confirm exact field
  propertySqft: integer("property_sqft"),                            // ISN: GAP
  propertyFoundation: varchar("property_foundation", { length: 100 }),
  propertyOccupancy: varchar("property_occupancy", { length: 100 }),
  propertyBedrooms: integer("property_bedrooms"),                    // GAP from Phase 2
  propertyBathrooms: decimal("property_bathrooms", { precision: 4, scale: 1 }), // GAP from Phase 2

  // Multi-axis status
  status: varchar("status", { length: 50 }).notNull().default("scheduled"),
  // Allowed: scheduled | confirmed | en_route | in_progress | completed | cancelled | no_show
  paymentStatus: varchar("payment_status", { length: 50 }).notNull().default("unpaid"),
  signatureStatus: varchar("signature_status", { length: 50 }).notNull().default("unsigned"),
  qaStatus: varchar("qa_status", { length: 50 }).notNull().default("not_reviewed"),
  reportReleased: boolean("report_released").default(false).notNull(),
  reportReleasedAt: timestamp("report_released_at", { withTimezone: true }),

  // Finance
  feeAmount: decimal("fee_amount", { precision: 10, scale: 2 }).notNull(),
  // Detailed line items live in inspection_services. fee_amount is the total.

  // Notes
  specialInstructions: text("special_instructions"),                  // visible to inspector and client
  internalNotes: text("internal_notes"),                              // staff only

  // Lifecycle
  rescheduleCount: integer("reschedule_count").default(0).notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  // Booking source (how this inspection got into the system)
  source: varchar("source", { length: 50 }).default("dispatcher"),    // dispatcher | realtor_portal | client_booking | phone | email | api
  sourceContactId: uuid("source_contact_id").references(() => contacts.id), // who initiated

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
}, (t) => ({
  byScheduled: index("inspections_scheduled_at_idx").on(t.scheduledAt),
  byInspector: index("inspections_inspector_idx").on(t.inspectorId),
  byStatus: index("inspections_status_idx").on(t.status),
  byClient: index("inspections_client_idx").on(t.clientId),
  byOffice: index("inspections_office_idx").on(t.officeId),
  byIsnSource: uniqueIndex("inspections_isn_source_idx").on(t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
}));

// Multi-inspector orders (rare). One row per assigned inspector beyond the lead.
export const inspectionInspectors = pgTable("inspection_inspectors", {
  inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
  inspectorId: uuid("inspector_id").notNull().references(() => users.id),
  role: varchar("role", { length: 50 }).default("secondary").notNull(), // primary | secondary
  assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  assignedBy: uuid("assigned_by").references(() => users.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.inspectionId, t.inspectorId] }),
}));

// Per-inspection service line items (existing Replit pattern, retained).
export const inspectionServices = pgTable("inspection_services", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  fee: decimal("fee", { precision: 10, scale: 2 }).notNull(),
  durationMinutes: integer("duration_minutes"),                       // override at the line-item level if needed
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byInspection: index("inspection_services_inspection_idx").on(t.inspectionId),
}));

// =============================================================================
// reschedule_history (existing pattern, switched to scheduled_at)
// =============================================================================
export const rescheduleHistory = pgTable("reschedule_history", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
  previousScheduledAt: timestamp("previous_scheduled_at", { withTimezone: true }).notNull(),
  newScheduledAt: timestamp("new_scheduled_at", { withTimezone: true }).notNull(),
  previousInspectorId: uuid("previous_inspector_id").references(() => users.id),
  newInspectorId: uuid("new_inspector_id").references(() => users.id),
  reason: text("reason"),
  initiatedBy: uuid("initiated_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byInspection: index("reschedule_history_inspection_idx").on(t.inspectionId),
}));

// =============================================================================
// audit_log (retained as-is from existing Replit)
// =============================================================================
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").references(() => users.id),
  action: varchar("action", { length: 50 }).notNull(),                // create | update | delete | view | release | override | reschedule | cancel
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: uuid("entity_id"),
  changes: jsonb("changes"),                                          // { before, after }
  ipAddress: varchar("ip_address", { length: 64 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byEntity: index("audit_log_entity_idx").on(t.entityType, t.entityId),
  byUser: index("audit_log_user_idx").on(t.userId),
  byCreatedAt: index("audit_log_created_at_idx").on(t.createdAt),
}));

// =============================================================================
// Tables NOT included in this draft (out of scheduling slice)
// =============================================================================
// These exist in the Replit project and will be reused as-is unless changed by a later slice:
//   files, agreement_templates, agreements, payment_events,
//   automation_rules, automation_queue, automation_logs,
//   email_templates, email_template_assignments, email_template_conditions,
//   email_jobs, email_logs, email_provider_events,
//   sms_templates, integrations_config, communication_log, inspection_notes,
//   company_settings (will likely be folded into offices)
//
// company_settings is flagged for retirement: most of its responsibilities are
// either per-office (move to offices table) or per-account (move to a future
// account table). Decision documented in 01-schema-rationale.md (pending).

// =============================================================================
// Zod insert schemas (subset for draft; full set added on lock-in)
// =============================================================================
export const insertOfficeSchema = createInsertSchema(offices).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserRoleSchema = createInsertSchema(userRoles).omit({ grantedAt: true });
export const insertInspectorHoursSchema = createInsertSchema(inspectorHours).omit({ id: true, createdAt: true });
export const insertInspectorTimeOffSchema = createInsertSchema(inspectorTimeOff).omit({ id: true, createdAt: true });
export const insertInspectorZipSchema = createInsertSchema(inspectorZips);
export const insertServiceSchema = createInsertSchema(services).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAgencySchema = createInsertSchema(agencies).omit({ id: true, createdAt: true, updatedAt: true });
export const insertContactSchema = createInsertSchema(contacts).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInspectionSchema = createInsertSchema(inspections).omit({ id: true, createdAt: true, updatedAt: true, orderNumber: true });
export const insertRescheduleHistorySchema = createInsertSchema(rescheduleHistory).omit({ id: true, createdAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLog).omit({ id: true, createdAt: true });

// =============================================================================
// Types
// =============================================================================
export type Office = typeof offices.$inferSelect;
export type InsertOffice = z.infer<typeof insertOfficeSchema>;
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserRole = typeof userRoles.$inferSelect;
export type InspectorHours = typeof inspectorHours.$inferSelect;
export type InspectorTimeOff = typeof inspectorTimeOff.$inferSelect;
export type InspectorZip = typeof inspectorZips.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Agency = typeof agencies.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Inspection = typeof inspections.$inferSelect;
export type RescheduleHistoryEntry = typeof rescheduleHistory.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
