/**
 * 01-schema.draft.ts (v2, multi-business)
 *
 * STATUS: DRAFT, awaiting Troy's review. Do not import. Do not migrate.
 *
 * Architecture: Pattern B, shared customers and properties across businesses,
 * separated users and operations per business. See:
 *   ../decisions/2026-04-26-multi-business-architecture.md
 *
 * Foundational principles every table is evaluated against:
 *   - Security spec:                ./06-security-spec.md
 *   - Scalability spec:             ./07-scalability-spec.md
 *   - Multi-business extensibility: ./08-multi-business-extensibility-spec.md
 *
 * Source of truth:
 * - v1 superseded:           ./01-schema.v1.draft.ts.superseded (design history)
 * - Existing Replit project: ../replit-snapshot/shared/schema.ts (reuse where possible)
 * - ISN OpenAPI spec:        ../discovery/isn-openapi.json
 * - Phase 0 results:         ../discovery/03-phase0-results.md
 * - Phase 1 results:         ../discovery/04-phase1-results.md
 * - Existing Replit state:   ../discovery/existing-replit-state.md
 * - Design decisions:        ../decisions/2026-04-26-design-decisions.md
 * - Architecture decision:   ../decisions/2026-04-26-multi-business-architecture.md
 * - Phase 2 pilot findings:  ../discovery/07-phase2-pilot-findings.md
 * - Phase 2 augment+history: ../discovery/08-phase2-augment-history-findings.md
 * - Schema rationale draft:  ./01-schema-rationale.draft.md
 *
 * Conventions:
 * - All TS strict.
 * - Drizzle pgTable + drizzle-zod insert schemas.
 * - Column comments include the ISN source field where applicable ("ISN: <field>").
 * - "NEW" tag on fields the rebuild adds that ISN does not surface.
 * - PII columns marked inline with `// PII: <type>` per security spec S2.
 * - Decisions D1 (per-business role overlap), D2 (pagination), D3 (timestamptz),
 *   D5 (sizing as input data), and the multi-business architecture decision applied.
 * - Gaps marked "// GAP:" inline. Fill from Phase 2 + 3 results before locking.
 *
 * Naming convention:
 * - Tables that ARE shared across businesses do not carry `business_id`.
 * - Tables that are SCOPED to a business carry `business_id` (always not-null,
 *   except where the row could legitimately be account-level).
 * - Cross-business activity tracking lives in `*_businesses` junctions.
 *
 * Per-table principle annotations:
 * Every table block is preceded by a four-line header confirming evaluation:
 *   // Table: <name>
 *   // Security:      <PII fields | none>, <encryption notes>, <soft-delete: yes/no>, <RLS: business-scoped | shared | system>
 *   // Scalability:   <partition key | none>, <hot indexes>, <expected row count at 10x>
 *   // Multi-business: <shared | scoped | junction>, <how it adapts when a new business is added>
 *
 * NOTE on PII markers and soft-delete columns: the v2 draft below shows the
 * principle annotations on EVERY table. Soft-delete columns (deletedAt,
 * deletedBy, deleteReason) are present where the table holds PII or operational
 * history per security spec S4. They were NOT in the v1 draft; their addition
 * is part of this annotation pass and is open for review.
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
// Reference data: businesses and roles
// =============================================================================

export const BUSINESS_TYPES = [
  "inspection",
  "pool",
  "pest",
  "other",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

// Per-business roles. Names are intentionally generic ("technician") so they
// reuse across business types. UI maps technician + inspection business -> "Inspector",
// technician + pool business -> "Pool Tech", technician + pest business -> "Pest Tech".
export const ROLES = [
  "owner",
  "operations_manager",
  "dispatcher",
  "technician",         // unified term: inspector | pool tech | pest tech depending on business type
  "client_success",
  "bookkeeper",
  "viewer",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_PRIORITY: Role[] = [
  "owner",
  "operations_manager",
  "dispatcher",
  "technician",
  "bookkeeper",
  "client_success",
  "viewer",
];

export const ROLES_IN_TRANSACTION = [
  "buyer_agent",
  "listing_agent",
  "transaction_coordinator",
  "escrow_officer",
  "insurance_agent",
  "seller",
  "other",
] as const;
export type RoleInTransaction = (typeof ROLES_IN_TRANSACTION)[number];

// =============================================================================
// accounts (forward placeholder, not built now)
// =============================================================================
// Reserved for master multi-business management, billing, white-label settings.
// Deferred per the multi-business architecture decision. Single account today.
// Not creating the table now to avoid an empty stub. When introduced, every
// `businesses` row gains an `account_id` FK. Captured here so the omission is
// deliberate, not forgotten.

// =============================================================================
// businesses
// =============================================================================
// Table: businesses
// Security:      PII (none, business contact info is corporate, not personal). No encryption needed. Soft-delete: yes via `status='inactive'` (no PII to wipe). RLS: shared (every authenticated user can see businesses they belong to via user_businesses).
// Scalability:   No partition key. Index on (status). Expected row count at 10x: ~10 rows. This table never grows past dozens.
// Multi-business: SHARED. Adding a new business is one INSERT into this table per spec 08 M1 and the worked example. No schema change to other tables.
export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),         // URL-safe (e.g., "safehouse", "hcj-pools", "pest-heroes")
  type: varchar("type", { length: 50 }).notNull(),                   // BUSINESS_TYPES
  status: varchar("status", { length: 50 }).notNull().default("active"), // active | inactive

  // Branding
  logoUrl: varchar("logo_url", { length: 500 }),
  primaryColor: varchar("primary_color", { length: 16 }),            // hex like "#0F172A"

  // Contact (corporate, not personal PII)
  address1: text("address1"),
  address2: text("address2"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 2 }),
  zip: varchar("zip", { length: 20 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  website: varchar("website", { length: 255 }),

  // Catch-all for business-specific config (operating hours templates, default
  // service-area defaults, integration toggles, etc.). Promoted to columns
  // when patterns settle.
  config: jsonb("config").default(sql`'{}'::jsonb`).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byStatus: index("businesses_status_idx").on(t.status),
}));

// =============================================================================
// users (no single-business assumption)
// =============================================================================
// Table: users
// Security:      PII heavy (name, email, phone, address, license, photo). Encryption at rest required for password_hash; PII column-level encryption decision deferred to security spec finalization. Soft-delete: yes via `status='inactive'` plus optional deleted_at. RLS: shared (users themselves are global; access to a user's data is gated via user_businesses membership).
// Scalability:   No partition key. Indexes on (status), (email) unique. Expected row count at 10x: ~3,000 (50 active inspectors per business + customer-success + dispatchers + bookkeeping + dormant + multi-business owners).
// Multi-business: SHARED. A user can belong to many businesses via user_businesses. Adding a new business does not touch this table.
// Internal team only. Customers and realtors live in `customers` and
// `transaction_participants`.
// Per D1 (multi-business update): roles live in `user_roles` keyed by
// (user_id, business_id, role). `users.primary_role` is no longer cached
// here because it depends on the active business context. UI computes it on
// the fly from `user_roles` filtered to the current business.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email", { length: 255 }).notNull().unique(),       // PII: contact_email | ISN: emailaddress
  username: varchar("username", { length: 100 }).unique(),           // PII: name (sometimes user identity) | ISN: username
  passwordHash: varchar("password_hash", { length: 255 }),           // PII: credentials

  // Identity
  firstName: varchar("first_name", { length: 100 }),                 // PII: name | ISN: firstname
  lastName: varchar("last_name", { length: 100 }),                   // PII: name | ISN: lastname
  displayName: varchar("display_name", { length: 200 }).notNull(),   // PII: name | ISN: displayname

  // Contact
  phone: varchar("phone", { length: 50 }),                           // PII: phone | ISN: phone
  mobile: varchar("mobile", { length: 50 }),                         // PII: phone | ISN: mobile
  fax: varchar("fax", { length: 50 }),                               // PII: phone | ISN: fax
  address1: text("address1"),                                        // PII: address | ISN: address1
  address2: text("address2"),                                        // PII: address | ISN: address2
  city: varchar("city", { length: 100 }),                            // PII: address | ISN: city
  state: varchar("state", { length: 2 }),                            // PII: address | ISN: stateabbreviation
  zip: varchar("zip", { length: 20 }),                               // PII: address | ISN: zip
  county: varchar("county", { length: 100 }),                        // PII: address | ISN: county

  // Profession
  license: varchar("license", { length: 100 }),                      // PII: government_id | ISN: license
  licenseType: varchar("license_type", { length: 100 }),             // ISN: licensetype
  bio: text("bio"),                                                  // ISN: bio
  photoUrl: varchar("photo_url", { length: 500 }),                   // PII: name (photo) | ISN: photourl

  // Comms preferences
  smsOptIn: boolean("sms_opt_in").default(false).notNull(),          // ISN: sendSMS coerced
  emailOptIn: boolean("email_opt_in").default(true).notNull(),       // NEW

  // Account state
  status: varchar("status", { length: 50 }).default("active").notNull(), // active | inactive | invited

  // Migration provenance
  isnSourceId: uuid("isn_source_id").unique(),                       // ISN: id (preserved through migration)

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byStatus: index("users_status_idx").on(t.status),
}));

// =============================================================================
// user_businesses (membership)
// =============================================================================
// Table: user_businesses
// Security:      No PII directly. References users.id and businesses.id. RLS: business-scoped on read (a user only sees their own memberships and the memberships of users in businesses they manage). Soft-delete: yes via `status='inactive'`.
// Scalability:   PK is composite (user_id, business_id). Indexes on (business_id), (user_id). Expected row count at 10x: ~5,000 (3,000 users × ~1.5 average business membership). Small.
// Multi-business: JUNCTION. Core mechanism for adding a user to a new business. No schema change when a new business is added; INSERT a row.

// Tells us which businesses each user belongs to. is_primary is the user's
// "home" business; UI defaults to it on login.
export const userBusinesses = pgTable("user_businesses", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  isPrimary: boolean("is_primary").default(false).notNull(),
  status: varchar("status", { length: 50 }).default("active").notNull(), // active | inactive (removed without deleting history)
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.businessId] }),
  byBusiness: index("user_businesses_business_idx").on(t.businessId),
  byUser: index("user_businesses_user_idx").on(t.userId),
  // Enforce only one primary per user
  primaryUnique: uniqueIndex("user_businesses_primary_unique").on(t.userId).where(sql`${t.isPrimary} = true`),
}));

// =============================================================================
// user_roles (per-business)
// =============================================================================
// Table: user_roles
// Security:      No PII directly. Drives permission decisions, so RLS-aware. Soft-delete: rows are removed (revocation), with a corresponding audit_log entry instead of soft-delete. Read-audit on this table per S5 because role grants are sensitive.
// Scalability:   PK is composite (user_id, business_id, role). Index on (business_id, role) for "who has role X in business Y" queries. Expected row count at 10x: ~10,000.
// Multi-business: JUNCTION. New business adds rows here for relevant staff; no schema change.

// D1 + multi-business: role assignments are per (user, business). A user can
// hold roles in multiple businesses simultaneously.
export const userRoles = pgTable("user_roles", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 50 }).notNull(),                   // ROLES
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  grantedBy: uuid("granted_by").references(() => users.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.businessId, t.role] }),
  byBusinessRole: index("user_roles_business_role_idx").on(t.businessId, t.role),
}));

// =============================================================================
// Customers (shared, no business_id)
// =============================================================================
// Table: customers
// Security:      PII heavy (name, email, multiple phones, mailing address). Column-level encryption candidate for email and phone (these get queried for dedupe; encryption strategy must support deterministic encryption or HMAC index for search). Soft-delete: yes (deletedAt, deletedBy, deleteReason). RLS: shared with cross-business access enforced through customer_businesses, but RLS itself is permissive at this table; the API layer (and S8 export gate) enforces business scoping on reads.
// Scalability:   No partition key. Indexes on (email lower-case), (display_name lower-case), unique on isn_source_id. Expected row count at 10x: 100,000+. The dedupe lookups on email and address are hot.
// Multi-business: SHARED. customer_businesses junction tracks which businesses have transacted with each customer. Adding a new business does not touch this table.

// People who pay us / receive service. Reusable across all businesses.
// ISN's `clients` map mostly here. Edge cases handled in migration plan.
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  firstName: varchar("first_name", { length: 100 }),                 // PII: name
  lastName: varchar("last_name", { length: 100 }),                   // PII: name
  displayName: varchar("display_name", { length: 200 }).notNull(),   // PII: name

  email: varchar("email", { length: 255 }),                          // PII: contact_email | not unique, same person can appear with secondary email
  phoneMobile: varchar("phone_mobile", { length: 50 }),              // PII: phone
  phoneHome: varchar("phone_home", { length: 50 }),                  // PII: phone
  phoneWork: varchar("phone_work", { length: 50 }),                  // PII: phone

  // Mailing address (separate from properties; a customer's address is not
  // necessarily the property being inspected).
  address1: text("address1"),                                        // PII: address
  address2: text("address2"),                                        // PII: address
  city: varchar("city", { length: 100 }),                            // PII: address
  state: varchar("state", { length: 2 }),                            // PII: address
  zip: varchar("zip", { length: 20 }),                               // PII: address

  notes: text("notes"),                                              // PII: notes (free text may contain anything)

  smsOptIn: boolean("sms_opt_in").default(false).notNull(),
  emailOptIn: boolean("email_opt_in").default(true).notNull(),

  // Migration provenance (which ISN entity this came from). Allows clean
  // reverse-lookup during cutover.
  isnSourceId: uuid("isn_source_id"),                                // ISN: client.id
  isnSourceType: varchar("isn_source_type", { length: 50 }),         // "client"

  status: varchar("status", { length: 50 }).default("active").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byEmail: index("customers_email_idx").on(t.email),
  byNameLower: index("customers_name_lower_idx").on(sql`lower(${t.displayName})`),
  byIsnSource: uniqueIndex("customers_isn_source_idx").on(t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
}));

// customer_businesses junction
// "Which businesses has this customer used."
// Updated as activity occurs (or backfilled in migration).
// Table: customer_businesses
// Security:      No PII directly. RLS: business-scoped (a user can only see customer_businesses rows for their businesses).
// Scalability:   PK is composite (customer_id, business_id). Indexes on (business_id), (last_activity_at). Expected row count at 10x: ~150,000 (100K customers × 1.5 average business cross-use).
// Multi-business: JUNCTION. Core cross-business activity tracker.
export const customerBusinesses = pgTable("customer_businesses", {
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar("status", { length: 50 }).default("active").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.customerId, t.businessId] }),
  byBusiness: index("customer_businesses_business_idx").on(t.businessId),
  byLastActivity: index("customer_businesses_last_activity_idx").on(t.lastActivityAt),
}));

// =============================================================================
// Properties (shared, no business_id)
// =============================================================================
// Table: properties
// Security:      PII (address is PII when tied to a customer, location_precise via lat/long is PII). Encryption candidate for address fields. Soft-delete: yes (deletedAt, deletedBy, deleteReason). RLS: shared, with API and export gates enforcing business scoping.
// Scalability:   No partition key. Indexes on (zip), (city, state), (lower(address1), zip). Expected row count at 10x: 100,000+. Property dedupe on (address1, city, state, zip) is hot.
// Multi-business: SHARED. property_businesses junction tracks usage. New business adds rows in junction, not in properties.

// Real-world physical properties. A property serviced by Safe House (inspection)
// could also be serviced by HCJ (pool) or Pest Heroes (pest). Property fields
// previously inline on `inspections` move here.
export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

  // Address (the physical address, normalized)
  address1: text("address1").notNull(),                              // PII: address
  address2: text("address2"),                                        // PII: address
  city: varchar("city", { length: 100 }).notNull(),                  // PII: address
  state: varchar("state", { length: 2 }).notNull(),                  // PII: address
  zip: varchar("zip", { length: 20 }).notNull(),                     // PII: address
  county: varchar("county", { length: 100 }),                        // PII: address

  // Geocoding (populated async by integration; nullable until then)
  latitude: decimal("latitude", { precision: 9, scale: 6 }),         // PII: location_precise
  longitude: decimal("longitude", { precision: 9, scale: 6 }),       // PII: location_precise

  // Property metadata. Extend as Phase 2 reveals more ISN fields.
  yearBuilt: integer("year_built"),                                  // GAP confirm Phase 2
  squareFeet: integer("square_feet"),                                // GAP confirm Phase 2
  bedrooms: integer("bedrooms"),                                     // GAP confirm Phase 2
  bathrooms: decimal("bathrooms", { precision: 4, scale: 1 }),       // GAP confirm Phase 2
  foundation: varchar("foundation", { length: 100 }),                // GAP confirm Phase 2
  occupancy: varchar("occupancy", { length: 100 }),                  // GAP confirm Phase 2
  propertyType: varchar("property_type", { length: 100 }),           // single_family | condo | townhouse | multi_family | commercial | other

  notes: text("notes"),

  // Open question for the spec rationale doc:
  // dedupe strategy on physical address. Considering:
  //   1. Strict match on (address1, city, state, zip) lowercased after normalization
  //   2. Allow soft-duplicate with a merge UI
  //   3. Use a third-party address validator (USPS, Smarty) on ingest
  // For now, a partial unique index on a normalized hash that we leave nullable
  // so dedup can be opt-in.
  // GAP: pick strategy when we draft 04-field-mapping.md.

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byZip: index("properties_zip_idx").on(t.zip),
  byCityState: index("properties_city_state_idx").on(t.city, t.state),
  byAddrLower: index("properties_addr_lower_idx").on(sql`lower(${t.address1})`, t.zip),
}));

// property_businesses junction
// "Which businesses have serviced this property."
// Table: property_businesses
// Security:      No PII directly. RLS: business-scoped.
// Scalability:   PK composite (property_id, business_id). Index on (business_id). Expected row count at 10x: ~150,000.
// Multi-business: JUNCTION.
export const propertyBusinesses = pgTable("property_businesses", {
  propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar("status", { length: 50 }).default("active").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.propertyId, t.businessId] }),
  byBusiness: index("property_businesses_business_idx").on(t.businessId),
}));

// Optional link: customer to property (for repeat customers at the same place,
// or rental scenarios where the customer doesn't own the property). Many-to-many.
// Table: customer_properties
// Security:      No PII directly. RLS: business-scoped through both ends (a user sees rows where the customer or property has a customer_businesses or property_businesses row in one of their businesses).
// Scalability:   PK composite (customer_id, property_id). Expected row count at 10x: ~120,000 (most customers tied to ~1 property, repeat customers and rental scenarios add a tail).
// Multi-business: SHARED. The relationship is business-agnostic.
export const customerProperties = pgTable("customer_properties", {
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  relationship: varchar("relationship", { length: 50 }),             // owner | buyer | seller | renter | manager | other
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.customerId, t.propertyId] }),
}));

// =============================================================================
// Transaction participants (shared, no business_id)
// =============================================================================
// Table: transaction_participants
// Security:      PII (name, email, phone). Same encryption posture as customers. Soft-delete: yes (deletedAt, deletedBy, deleteReason). RLS: shared, API/export gates enforce business scoping through inspection_participants links.
// Scalability:   No partition key. Indexes on (email), (agency_id). Expected row count at 10x: ~50,000 (realtors, TCs, escrow, insurance for the territories we operate in).
// Multi-business: SHARED. The same realtor can participate in inspections, pool jobs, and pest treatments. Linkage via per-op participant junctions.

// Realtors, transaction coordinators, escrow officers, insurance agents.
// Distinct from customers. Linked to operations via operation-specific
// junctions (today: inspection_participants).
export const transactionParticipants = pgTable("transaction_participants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  agencyId: uuid("agency_id").references(() => agencies.id),         // optional; realtors usually have an agency, others may not

  firstName: varchar("first_name", { length: 100 }),                 // PII: name
  lastName: varchar("last_name", { length: 100 }),                   // PII: name
  displayName: varchar("display_name", { length: 200 }).notNull(),   // PII: name

  email: varchar("email", { length: 255 }),                          // PII: contact_email
  phone: varchar("phone", { length: 50 }),                           // PII: phone
  mobile: varchar("mobile", { length: 50 }),                         // PII: phone

  // Their primary role taxonomy. Same person can serve multiple roles across
  // transactions; this column captures their dominant historical role.
  // The actual role on a given inspection lives on the participant junction.
  primaryRole: varchar("primary_role", { length: 50 }),              // ROLES_IN_TRANSACTION

  notes: text("notes"),

  // Migration provenance
  isnSourceId: uuid("isn_source_id"),
  isnSourceType: varchar("isn_source_type", { length: 50 }),         // "agent" | "escrowofficer" | "insuranceagent"

  status: varchar("status", { length: 50 }).default("active").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byEmail: index("tparticipants_email_idx").on(t.email),
  byAgency: index("tparticipants_agency_idx").on(t.agencyId),
  byIsnSource: uniqueIndex("tparticipants_isn_source_idx").on(t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
}));

// =============================================================================
// Agencies (shared with junction)
// =============================================================================
// Table: agencies
// Security:      PII (corporate contact info, not heavy personal). Encryption not required at column level. Soft-delete: yes via `active=false` plus optional deletedAt. RLS: shared, API enforces business scoping through agency_businesses.
// Scalability:   No partition key. Index on lower(name). Expected row count at 10x: ~5,000 brokerages and similar.
// Multi-business: SHARED with agency_businesses junction.
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

  isnSourceId: uuid("isn_source_id").unique(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byNameLower: index("agencies_name_lower_idx").on(sql`lower(${t.name})`),
}));

// Table: agency_businesses
// Security:      No PII directly. RLS: business-scoped.
// Scalability:   PK composite (agency_id, business_id). Expected row count at 10x: ~6,000.
// Multi-business: JUNCTION.
export const agencyBusinesses = pgTable("agency_businesses", {
  agencyId: uuid("agency_id").notNull().references(() => agencies.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
  status: varchar("status", { length: 50 }).default("active").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.agencyId, t.businessId] }),
  byBusiness: index("agency_businesses_business_idx").on(t.businessId),
}));

// =============================================================================
// Services (business-scoped)
// =============================================================================
// ISN's /ordertypes/ has no duration. We add it. Inspector overrides via
// inspector_service_durations.
// Table: services
// Security:      No PII. RLS: business-scoped at DB layer. Soft-delete via `active=false`.
// Scalability:   No partition key. Indexes on (business_id), (active). Expected row count at 10x: ~200 (low-cardinality config).
// Multi-business: SCOPED. Each business defines its own service catalog. Adding a new business adds new rows here scoped to that business.
export const services = pgTable("services", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),

  name: varchar("name", { length: 255 }).notNull(),                  // ISN: name
  description: text("description"),                                  // ISN: description (internal)
  publicDescription: text("public_description"),                     // ISN: publicdescription

  baseFee: decimal("base_fee", { precision: 10, scale: 2 }).notNull(),
  defaultDurationMinutes: integer("default_duration_minutes").notNull().default(180), // NEW
  sequence: integer("sequence").default(100).notNull(),
  active: boolean("active").default(true).notNull(),                 // ISN: show coerced

  // Provenance
  isnSourceId: uuid("isn_source_id").unique(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byBusiness: index("services_business_idx").on(t.businessId),
  byActive: index("services_active_idx").on(t.active),
}));

// =============================================================================
// Technician availability (business-scoped)
// =============================================================================
// Tables: inspector_hours, inspector_time_off, inspector_zips, inspector_service_durations
// Security:      No PII. RLS: business-scoped at DB layer.
// Scalability:   inspector_hours: ~5,000 rows at 10x (50 inspectors × 7 days × 1-2 windows). inspector_time_off: rolling, ~500 active rows. inspector_zips: ~10,000 rows (50 inspectors × 200 ZIPs avg). inspector_service_durations: ~2,000 rows. None partitioned. All keyed by (user_id, business_id) for hot lookups.
// Multi-business: SCOPED. Per the spec 08 M3 decision, availability is keyed per-business so a user who serves multiple businesses has separate hours per business.
//
// Naming open question (spec 08 open item #2): rename to technician_* to match
// the per-business term? Deferred until Troy reviews.
// "Technician" is the unified term across business types. Inspector at Safe
// House is a technician with role=technician in the Safe House business. Same
// for pool tech and pest tech.
//
// Decision: availability tables are scoped by business, not just by user. A
// user who is technician in two businesses (rare; but a possible "owner who
// also works the field") has separate hours per business.

export const inspectorHours = pgTable("inspector_hours", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(),                       // 0 Sun ... 6 Sat
  startTime: varchar("start_time", { length: 5 }).notNull(),         // "HH:MM" 24h
  endTime: varchar("end_time", { length: 5 }).notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUserBiz: index("inspector_hours_user_biz_idx").on(t.userId, t.businessId),
}));

export const inspectorTimeOff = pgTable("inspector_time_off", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUserBiz: index("inspector_time_off_user_biz_idx").on(t.userId, t.businessId),
  byWindow: index("inspector_time_off_window_idx").on(t.startsAt, t.endsAt),
}));

export const inspectorZips = pgTable("inspector_zips", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  zip: varchar("zip", { length: 20 }).notNull(),
  priority: integer("priority").default(1).notNull(),                // 1 primary ... 5 will-go-if-needed
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.businessId, t.zip] }),
  byZipBiz: index("inspector_zips_zip_biz_idx").on(t.zip, t.businessId),
}));

export const inspectorServiceDurations = pgTable("inspector_service_durations", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  durationMinutes: integer("duration_minutes").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.serviceId] }),
}));

// =============================================================================
// Inspections (business-scoped, the one operational table built today)
// =============================================================================
// Pattern other operational tables (pool_jobs, pest_treatments) will mirror
// when they are built.
// Table: inspections
// Security:      PII via FKs (customer, property, participants). Direct PII: special_instructions and internal_notes can contain notes about the property/owner. Encryption candidate for special_instructions (free text) deferred. Soft-delete: yes (deletedAt, deletedBy, deleteReason); cancelledAt is the operational equivalent that maps from ISN's deleteddatetime per platform issue #9. RLS: business-scoped at DB layer.
// Scalability:   PARTITION CANDIDATE on (business_id, scheduled_at) yearly per spec 07 Sc4. Not partitioned today. Indexes: (business_id, status, scheduled_at), (business_id, lead_inspector_id, scheduled_at), (business_id, customer_id, scheduled_at desc), (business_id, property_id, scheduled_at desc), (status), unique (isn_source_id where not null). Expected row count at 10x: ~60,000/year per business sustained, ~600,000 cumulative across 10 years. Hot path: dispatcher dashboard, inspector daily view (spec 07 Sc5).
// Multi-business: SCOPED. The pattern other ops tables (pool_jobs, pest_treatments) mirror per spec 08 M2.
export const inspections = pgTable("inspections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(), // SH-YYYY-NNNN

  // Source tracking
  isnSourceId: uuid("isn_source_id").unique(),                       // ISN: id
  isnReportNumber: varchar("isn_report_number", { length: 50 }),     // ISN: reportnumber

  // Scheduling (D3: timestamptz + duration)
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(180),
  // Generated end column omitted from this draft pending Drizzle generated
  // column support verification. Either generated column or computed in queries.
  // GAP: confirm in schema rationale doc.

  // Lead inspector (single; multi-inspector via inspection_inspectors junction)
  leadInspectorId: uuid("lead_inspector_id").references(() => users.id),

  // Customer and property (shared)
  customerId: uuid("customer_id").references(() => customers.id),
  propertyId: uuid("property_id").references(() => properties.id),

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

  // Notes
  specialInstructions: text("special_instructions"),                  // PII: notes (free text) | visible to inspector and (some channels) client
  internalNotes: text("internal_notes"),                              // PII: notes (free text) | staff only

  // Lifecycle
  rescheduleCount: integer("reschedule_count").default(0).notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  // Booking source
  source: varchar("source", { length: 50 }).default("dispatcher"),
  // dispatcher | realtor_portal | client_booking | phone | email | api
  sourceParticipantId: uuid("source_participant_id").references(() => transactionParticipants.id),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
}, (t) => ({
  byBusiness: index("inspections_business_idx").on(t.businessId),
  byScheduled: index("inspections_scheduled_at_idx").on(t.scheduledAt),
  byInspector: index("inspections_lead_inspector_idx").on(t.leadInspectorId),
  byStatus: index("inspections_status_idx").on(t.status),
  byCustomer: index("inspections_customer_idx").on(t.customerId),
  byProperty: index("inspections_property_idx").on(t.propertyId),
  byBizScheduled: index("inspections_biz_scheduled_idx").on(t.businessId, t.scheduledAt),
}));

// Multi-inspector orders. One row per assigned inspector beyond the lead.
// Table: inspection_inspectors
// Security:      No PII. RLS: business-scoped via inspections FK.
// Scalability:   PK composite (inspection_id, inspector_id). Expected row count at 10x: ~5% of inspections × 1-2 secondary inspectors = ~6,000.
// Multi-business: SCOPED via parent inspections.
export const inspectionInspectors = pgTable("inspection_inspectors", {
  inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
  inspectorId: uuid("inspector_id").notNull().references(() => users.id),
  role: varchar("role", { length: 50 }).default("secondary").notNull(), // primary | secondary
  assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  assignedBy: uuid("assigned_by").references(() => users.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.inspectionId, t.inspectorId] }),
}));

// Inspection participants (realtors, TC, etc. on this specific inspection)
// Table: inspection_participants
// Security:      No direct PII (links transaction_participants which carry PII). RLS: business-scoped via inspections FK.
// Scalability:   PK composite (inspection_id, participant_id, role_in_transaction). Indexes on (participant_id), (role_in_transaction). Expected row count at 10x: ~120,000 (60K inspections × ~2 participants each).
// Multi-business: SCOPED via parent inspections. The same transaction_participant can appear on inspection_participants for one business AND on a future pool_job_participants for another, since transaction_participants is shared.
export const inspectionParticipants = pgTable("inspection_participants", {
  inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
  participantId: uuid("participant_id").notNull().references(() => transactionParticipants.id, { onDelete: "restrict" }),
  roleInTransaction: varchar("role_in_transaction", { length: 50 }).notNull(), // ROLES_IN_TRANSACTION
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.inspectionId, t.participantId, t.roleInTransaction] }),
  byParticipant: index("inspection_participants_participant_idx").on(t.participantId),
  byRole: index("inspection_participants_role_idx").on(t.roleInTransaction),
}));

// Inspection service line items
// Table: inspection_services
// Security:      No PII. RLS: business-scoped via inspections FK.
// Scalability:   Indexes on (inspection_id). Expected row count at 10x: ~120,000 (60K inspections × ~2 line items).
// Multi-business: SCOPED via parent inspections.
export const inspectionServices = pgTable("inspection_services", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id),
  fee: decimal("fee", { precision: 10, scale: 2 }).notNull(),
  durationMinutes: integer("duration_minutes"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byInspection: index("inspection_services_inspection_idx").on(t.inspectionId),
}));

// Reschedule history (D3: scheduled_at-based)
// Table: reschedule_history
// Security:      No direct PII. RLS: business-scoped via inspections FK.
// Scalability:   Index on (inspection_id). Expected row count at 10x: ~6,000/year (10% of inspections reschedule once).
// Multi-business: SCOPED via parent inspections. Open question (spec 08 #1): polymorphic across operational types vs per-op tables. Deferred.
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
// audit_log (gains business_id for scoped queries)
// =============================================================================
// Table: audit_log
// Security:      Contains references to entities and JSON blobs of changes. No direct PII column-by-column, but `changes` jsonb can hold PII snapshots (before/after). Encryption candidate for `changes` payload. Soft-delete: NO. Audit log is append-only. Hard delete only by data-retention job after a configured retention window. RLS: business-scoped on read via business_id (null business_id = system events, owner-only).
// Scalability:   PARTITION CANDIDATE on (business_id, created_at) quarterly per spec 07 Sc4. Highest-write table in the system. Indexes: (entity_type, entity_id), (user_id), (business_id), (created_at). Expected row count at 10x: ~2.4M/year per business at full audit posture (writes + reads of sensitive fields per S5).
// Multi-business: SCOPED on business_id (nullable for system-level events that span businesses). New businesses get their own log entries in the same table; partitioning later separates them physically.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessId: uuid("business_id").references(() => businesses.id),    // null for cross-business / account-level events
  userId: uuid("user_id").references(() => users.id),
  action: varchar("action", { length: 50 }).notNull(),                // create | update | delete | view | release | override | reschedule | cancel | login
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: uuid("entity_id"),
  changes: jsonb("changes"),                                          // { before, after }
  ipAddress: varchar("ip_address", { length: 64 }),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byEntity: index("audit_log_entity_idx").on(t.entityType, t.entityId),
  byUser: index("audit_log_user_idx").on(t.userId),
  byBusiness: index("audit_log_business_idx").on(t.businessId),
  byCreatedAt: index("audit_log_created_at_idx").on(t.createdAt),
}));

// =============================================================================
// Tables NOT included in this draft (reused or out of scheduling slice)
// =============================================================================
// Reused as-is from the existing Replit project unless changed by a later slice:
//   files, agreement_templates, agreements, payment_events,
//   automation_rules, automation_queue, automation_logs,
//   email_templates, email_template_assignments, email_template_conditions,
//   email_jobs, email_logs, email_provider_events,
//   sms_templates, integrations_config, communication_log, inspection_notes
//
// Each will need a `business_id` migration when its parent operation is
// multi-business-aware. For the scheduling slice, all the reused tables
// continue to scope to inspections via existing FKs, so business context
// flows through transitively.
//
// `company_settings` is retired in this design. Its responsibilities split:
//   - per-business settings move to `businesses.config` jsonb (or get promoted
//     to columns on `businesses` as patterns settle)
//   - account-level settings move to a future `accounts` table (deferred)

// =============================================================================
// Zod insert schemas (subset for draft; full set on lock-in)
// =============================================================================
export const insertBusinessSchema = createInsertSchema(businesses).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserBusinessSchema = createInsertSchema(userBusinesses).omit({ joinedAt: true });
export const insertUserRoleSchema = createInsertSchema(userRoles).omit({ grantedAt: true });
export const insertCustomerSchema = createInsertSchema(customers).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCustomerBusinessSchema = createInsertSchema(customerBusinesses).omit({ firstSeenAt: true, lastActivityAt: true });
export const insertPropertySchema = createInsertSchema(properties).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPropertyBusinessSchema = createInsertSchema(propertyBusinesses).omit({ firstSeenAt: true, lastActivityAt: true });
export const insertCustomerPropertySchema = createInsertSchema(customerProperties).omit({ createdAt: true });
export const insertTransactionParticipantSchema = createInsertSchema(transactionParticipants).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAgencySchema = createInsertSchema(agencies).omit({ id: true, createdAt: true, updatedAt: true });
export const insertAgencyBusinessSchema = createInsertSchema(agencyBusinesses).omit({ firstSeenAt: true, lastActivityAt: true });
export const insertServiceSchema = createInsertSchema(services).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInspectorHoursSchema = createInsertSchema(inspectorHours).omit({ id: true, createdAt: true });
export const insertInspectorTimeOffSchema = createInsertSchema(inspectorTimeOff).omit({ id: true, createdAt: true });
export const insertInspectorZipSchema = createInsertSchema(inspectorZips);
export const insertInspectorServiceDurationSchema = createInsertSchema(inspectorServiceDurations);
export const insertInspectionSchema = createInsertSchema(inspections).omit({ id: true, createdAt: true, updatedAt: true, orderNumber: true });
export const insertInspectionInspectorSchema = createInsertSchema(inspectionInspectors).omit({ assignedAt: true });
export const insertInspectionParticipantSchema = createInsertSchema(inspectionParticipants).omit({ createdAt: true });
export const insertInspectionServiceSchema = createInsertSchema(inspectionServices).omit({ id: true, createdAt: true });
export const insertRescheduleHistorySchema = createInsertSchema(rescheduleHistory).omit({ id: true, createdAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLog).omit({ id: true, createdAt: true });

// =============================================================================
// Types
// =============================================================================
export type Business = typeof businesses.$inferSelect;
export type InsertBusiness = z.infer<typeof insertBusinessSchema>;
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserBusiness = typeof userBusinesses.$inferSelect;
export type UserRole = typeof userRoles.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type CustomerBusiness = typeof customerBusinesses.$inferSelect;
export type Property = typeof properties.$inferSelect;
export type InsertProperty = z.infer<typeof insertPropertySchema>;
export type PropertyBusiness = typeof propertyBusinesses.$inferSelect;
export type CustomerProperty = typeof customerProperties.$inferSelect;
export type TransactionParticipant = typeof transactionParticipants.$inferSelect;
export type InsertTransactionParticipant = z.infer<typeof insertTransactionParticipantSchema>;
export type Agency = typeof agencies.$inferSelect;
export type AgencyBusiness = typeof agencyBusinesses.$inferSelect;
export type Service = typeof services.$inferSelect;
export type InsertService = z.infer<typeof insertServiceSchema>;
export type InspectorHours = typeof inspectorHours.$inferSelect;
export type InspectorTimeOff = typeof inspectorTimeOff.$inferSelect;
export type InspectorZip = typeof inspectorZips.$inferSelect;
export type InspectorServiceDuration = typeof inspectorServiceDurations.$inferSelect;
export type Inspection = typeof inspections.$inferSelect;
export type InsertInspection = z.infer<typeof insertInspectionSchema>;
export type InspectionInspector = typeof inspectionInspectors.$inferSelect;
export type InspectionParticipant = typeof inspectionParticipants.$inferSelect;
export type InspectionService = typeof inspectionServices.$inferSelect;
export type RescheduleHistoryEntry = typeof rescheduleHistory.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
