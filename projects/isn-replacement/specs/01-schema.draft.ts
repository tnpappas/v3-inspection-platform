/**
 * 01-schema.draft.ts (v3, licensing-ready)
 *
 * STATUS: DRAFT, awaiting Troy's review. Do not import. Do not migrate.
 *
 * Architecture: licensing-ready from the foundation. `accounts` is a first-class
 * top-level tenant; Pattern B (shared customers/properties across businesses)
 * holds within an account. Account isolation is the outer boundary, enforced
 * via RLS at the database layer per security spec S9.
 *
 * Foundational principles every table is evaluated against:
 *   - Security spec:                ./06-security-spec.md (S1-S9)
 *   - Scalability spec:             ./07-scalability-spec.md (Sc1-Sc7)
 *   - Multi-business extensibility: ./08-multi-business-extensibility-spec.md (M1-M6)
 *
 * Source of truth:
 * - v2 superseded:           ./01-schema.v2.draft.ts.superseded (design history)
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
 *   D5 (sizing as input data), multi-business architecture, and licensing-readiness
 *   directive 2026-04-27 12:53 UTC all applied.
 * - Gaps marked "// GAP:" inline. Fill from Phase 2 + 3 results before locking.
 *
 * Naming convention:
 * - Tables that carry `account_id` directly: top-level scoped tables (businesses,
 *   users, customers, properties, agencies, transaction_participants, audit_log).
 * - Operational tables (inspections, services, inspector_*, etc.) inherit account
 *   scope through their parent FK (typically business_id -> businesses.account_id).
 *   No denormalized account_id on those.
 * - `account_id` leads composite indexes on hot paths.
 *
 * Per-table principle annotations (4-line header on every table):
 *   // Table: <name>
 *   // Security:      <PII fields | none>, <encryption notes>, <soft-delete: yes/no>, <RLS: account-scoped | account-and-business-scoped | shared | system>
 *   // Scalability:   <partition key | none>, <hot indexes>, <expected row count at 10x>
 *   // Multi-business: <shared-within-account | scoped-to-business | junction>, <how it adapts when a new business is added>
 *
 * Enum convention (per Troy's directive 2026-04-27 12:53 UTC):
 * - Every enum-shaped column is declared as a `pgEnum` for DB-layer enforcement.
 * - Adding new enum values requires a migration (`ALTER TYPE ... ADD VALUE`).
 *   Trade-off documented in 01-schema-rationale.draft.md.
 *
 * Audit columns convention:
 * - `created_by` and `last_modified_by` (uuid references users.id) on tables that
 *   change rarely and matter for investigation. Nullable on `accounts` (chicken-and-egg
 *   for the seed account); non-null elsewhere where applicable.
 * - High-volume tables (inspections, customers, properties, transaction_participants,
 *   audit_log) skip these columns; audit_log captures the equivalent.
 *
 * Soft-delete convention (security spec S4):
 * - Tables with PII or operational history that should not be hard-deleted carry
 *   `deletedAt timestamptz`, `deletedBy uuid references users(id)`, `deleteReason text`.
 * - Indexed via `<table>_deleted_at_idx` since `WHERE deleted_at IS NULL` is the
 *   default read filter.
 * - audit_log is append-only; no soft-delete columns.
 * - user_roles uses revocation via DELETE plus audit_log row; no soft-delete columns.
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  decimal,
  jsonb,
  uuid,
  bigint,
  inet,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { accountConfigSchema, type AccountConfig } from "./shared/schemas/account-config";
import { businessConfigSchema, type BusinessConfig } from "./shared/schemas/business-config";

// =============================================================================
// Enums (DB-layer enforcement per Troy 2026-04-27)
// =============================================================================

export const accountStatusEnum = pgEnum("account_status", ["active", "suspended", "inactive"]);

export const businessTypeEnum = pgEnum("business_type", ["inspection", "pool", "pest", "other"]);
export const businessStatusEnum = pgEnum("business_status", ["active", "inactive"]);

export const userStatusEnum = pgEnum("user_status", ["active", "inactive", "invited"]);
export const membershipStatusEnum = pgEnum("membership_status", ["active", "inactive"]);

export const roleEnum = pgEnum("role", [
  "owner",
  "operations_manager",
  "dispatcher",
  "technician",
  "client_success",
  "bookkeeper",
  "viewer",
]);

export const customerStatusEnum = pgEnum("customer_status", ["active", "inactive"]);
export const contactRelationshipStatusEnum = pgEnum("contact_relationship_status", ["active", "inactive"]);

export const roleInTransactionEnum = pgEnum("role_in_transaction", [
  "buyer_agent",
  "listing_agent",
  "transaction_coordinator",
  "escrow_officer",
  "insurance_agent",
  "lender",                  // common in VA Beach real estate; relevant when billing to closing
  "attorney",                // closing attorney; can be the financial decision-maker for bill-to-closing workflow
  "seller",
  "other",
]);

export const inspectionStatusEnum = pgEnum("inspection_status", [
  "scheduled",
  "confirmed",
  "en_route",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
  "on_hold",               // bumped from previous date, new date not yet locked. Distinct from scheduled (has confirmed date) and rescheduled (had a new date instantly assigned)
]);
export const paymentStatusEnum = pgEnum("payment_status", [
  "unpaid",
  "partial",
  "paid",
  "refunded",
  "disputed",            // chargeback or customer-initiated dispute is in flight; payment effectively frozen until resolved
]);
export const signatureStatusEnum = pgEnum("signature_status", ["unsigned", "signed", "expired"]);
export const qaStatusEnum = pgEnum("qa_status", ["not_reviewed", "in_review", "approved", "rejected"]);

export const bookingSourceEnum = pgEnum("booking_source", [
  "dispatcher",
  "realtor_portal",
  "client_booking",
  "phone",
  "email",
  "api",
]);

export const inspectorOnInspectionRoleEnum = pgEnum("inspector_on_inspection_role", ["primary", "secondary"]);

export const auditActionEnum = pgEnum("audit_action", [
  "create",
  "update",
  "delete",
  "view",
  "release",
  "override",
  "reschedule",
  "cancel",
  "login",
  "logout",
  "read_sensitive",
  "export",                // bulk export of records (CSV, PDF, report download); distinct from view/read_sensitive
]);

// Outcome of an audited action. success is the default; the others let us log
// denied permission checks, blocked operations, and attempted exports without
// dropping them silently. See review item 3 (audit_log).
export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "success",
  "denied",                // permission check or RLS-style block prevented the action
  "failed",                // action attempted, encountered a runtime error (validation, FK, etc.)
  "partial",               // bulk action partially succeeded; details in `changes`
]);

// Canonical entity_type values for audit_log. Keep in sync with the application's
// constants. Adding a value here is a one-line code change; adding a value to a
// pgEnum requires a DB migration. The CHECK constraint on audit_log.entity_type
// references this list to give us DB-layer enforcement against typos and stale
// types without enum-migration overhead. See review item 5 (audit_log).
export const AUDIT_ENTITY_TYPES = [
  // tenants and identity
  "account",
  "business",
  "user",
  "user_credential",
  "user_security",
  "user_mfa_factor",
  "user_business",
  "user_role",
  // shared people / places
  "customer",
  "property",
  "customer_business",
  "property_business",
  "customer_property",
  "transaction_participant",
  "agency",
  "agency_business",
  // operational reference
  "service",
  "inspector_hours",
  "inspector_time_off",
  "inspector_zip",
  "inspector_service_duration",
  // operational rows
  "inspection",
  "inspection_inspector",
  "inspection_participant",
  "inspection_service",
  "reschedule_history",
  // synthetic / non-row events
  "login_attempt",         // pre-auth events with no entity_id
  "session",
  "export_job",            // future export job rows
  "system",                // background workers, migrations
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

// =============================================================================
// accounts (top-level licensing tenant)
// =============================================================================
// Table: accounts
// Security:      Account-level metadata. Billing fields are PII (billing email, billing address). Soft-delete: yes (deletedAt/deletedBy/deleteReason). RLS: system; only application-layer admin can read/mutate accounts. Cross-account leak here = catastrophic, so this is the most carefully gated table in the system.
// Scalability:   No partition key. Single seed row today. Index on (status), unique on slug. Expected row count at 10x: ~50 (licensees).
// Multi-business: ROOT. Adding a new account is the licensing-flow entry point. Per spec 08 worked example.
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 255 }).notNull(),                  // "Safe House Property Inspections (Pappas group)" or licensee org name
  slug: varchar("slug", { length: 100 }).notNull().unique(),         // GLOBALLY unique, used in URLs and in the licensing flow

  status: accountStatusEnum("status").notNull().default("active"),
  planTier: varchar("plan_tier", { length: 50 }).default("internal"), // "internal" for our own account; "starter"/"pro"/etc. for licensees

  // Billing (PII when populated)
  billingEmail: varchar("billing_email", { length: 255 }),           // PII: contact_email
  billingName: varchar("billing_name", { length: 255 }),             // PII: name
  billingAddress1: text("billing_address1"),                         // PII: address
  billingAddress2: text("billing_address2"),                         // PII: address
  billingCity: varchar("billing_city", { length: 100 }),             // PII: address
  billingState: varchar("billing_state", { length: 2 }),             // PII: address
  billingZip: varchar("billing_zip", { length: 20 }),                // PII: address
  billingCountry: varchar("billing_country", { length: 2 }).default("US"),

  // Catch-all configuration. Validated by accountConfigSchema in shared/schemas/.
  config: jsonb("config").default(sql`'{}'::jsonb`).notNull(),

  // Audit columns. Nullable FK to users.id (chicken-and-egg for the seed account:
  // no user exists yet when the first account row is inserted). Future accounts
  // created via the licensing flow populate these from the licensing actor.
  // FK constraint applies when populated; NULL is the only allowed unconstrained
  // value. Reviewed and confirmed: this is the only chicken-and-egg case in the
  // schema; every other table that has createdBy/lastModifiedBy uses non-null FKs.
  createdBy: uuid("created_by").references(() => users.id),
  lastModifiedBy: uuid("last_modified_by").references(() => users.id),

  // Soft-delete (security spec S4)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => users.id),
  deleteReason: text("delete_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byStatus: index("accounts_status_idx").on(t.status),
  byDeletedAt: index("accounts_deleted_at_idx").on(t.deletedAt),
}));

// =============================================================================
// businesses
// =============================================================================
// Table: businesses
// Security:      No personal PII (corporate contact info). Soft-delete: yes via status='inactive' for ops, deletedAt for admin removal. RLS: account-scoped; a user only sees businesses for their account, AND only sees the businesses they have user_businesses membership in.
// Scalability:   No partition key. Index on (account_id, status), unique on (account_id, slug). Expected row count at 10x: ~250 (50 accounts x ~5 businesses average).
// Multi-business: ROW-LEVEL within account. Adding a new business = INSERT here per spec 08 M1.
export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),

  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),                  // unique within account, NOT globally
  type: businessTypeEnum("type").notNull(),
  status: businessStatusEnum("status").notNull().default("active"),

  // Branding
  logoUrl: varchar("logo_url", { length: 500 }),
  primaryColor: varchar("primary_color", { length: 16 }),

  // Contact (corporate)
  address1: text("address1"),
  address2: text("address2"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 2 }),
  zip: varchar("zip", { length: 20 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  website: varchar("website", { length: 255 }),

  // UI display order. Application logic computes MAX(display_order)+1 within
  // the account on insert; reorder operations bump subsequent rows in a
  // transaction. Uniqueness on (account_id, display_order) enforces deterministic
  // ordering at the DB layer (see indexes below).
  displayOrder: integer("display_order").notNull().default(0),

  // Catch-all config; validated by businessConfigSchema in shared/schemas/.
  config: jsonb("config").default(sql`'{}'::jsonb`).notNull(),

  // Audit columns
  createdBy: uuid("created_by").notNull().references(() => users.id),
  lastModifiedBy: uuid("last_modified_by").notNull().references(() => users.id),

  // Soft-delete (security spec S4)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => users.id),
  deleteReason: text("delete_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byAccount: index("businesses_account_idx").on(t.accountId),
  byAccountStatus: index("businesses_account_status_idx").on(t.accountId, t.status),
  byAccountSlug: uniqueIndex("businesses_account_slug_unique").on(t.accountId, t.slug),
  byAccountDisplayOrder: uniqueIndex("businesses_account_display_order_unique").on(t.accountId, t.displayOrder),
  byDeletedAt: index("businesses_deleted_at_idx").on(t.deletedAt),
}));

// =============================================================================
// users (one account, Pattern 1)
// =============================================================================
// Table: users
// Security:      PII heavy (name, email, phone, address, license, photo).
//                Credentials live in user_credentials, NOT here. Login security
//                state lives in user_security. MFA factors in user_mfa_factors.
//                Email verification status here as `emailVerifiedAt`. Other PII
//                columns: column-level encryption decision deferred to security
//                spec finalization. Soft-delete: yes via status='inactive' (no
//                delete columns; users are not removed, just deactivated).
//                RLS: account-scoped; a user can never see users from other
//                accounts.
// Scalability:   No partition key. Indexes on (account_id, status),
//                (account_id, email) unique. Expected row count at 10x: ~30,000
//                across 50 accounts. Within a single account, ~600.
// Multi-business: ACCOUNT-SCOPED. A user belongs to exactly one account
//                 (Pattern 1, locked 2026-04-27 12:53 UTC). Membership in
//                 businesses within that account via user_businesses junction.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),

  email: varchar("email", { length: 255 }).notNull(),                // PII: contact_email | unique within account, not globally
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),  // null = unverified; required for sensitive notifications
  username: varchar("username", { length: 100 }),                    // PII: name (sometimes user identity) | ISN: username, unique within account

  // Identity
  firstName: varchar("first_name", { length: 100 }),                 // PII: name
  lastName: varchar("last_name", { length: 100 }),                   // PII: name
  displayName: varchar("display_name", { length: 200 }).notNull(),   // PII: name

  // Contact
  phone: varchar("phone", { length: 50 }),                           // PII: phone
  mobile: varchar("mobile", { length: 50 }),                         // PII: phone
  fax: varchar("fax", { length: 50 }),                               // PII: phone
  address1: text("address1"),                                        // PII: address
  address2: text("address2"),                                        // PII: address
  city: varchar("city", { length: 100 }),                            // PII: address
  state: varchar("state", { length: 2 }),                            // PII: address
  zip: varchar("zip", { length: 20 }),                               // PII: address
  county: varchar("county", { length: 100 }),                        // PII: address

  // Profession
  license: varchar("license", { length: 100 }),                      // PII: government_id
  licenseType: varchar("license_type", { length: 100 }),
  bio: text("bio"),
  photoUrl: varchar("photo_url", { length: 500 }),                   // PII: name (photo)

  // Comms preferences
  smsOptIn: boolean("sms_opt_in").default(false).notNull(),
  emailOptIn: boolean("email_opt_in").default(true).notNull(),

  status: userStatusEnum("status").notNull().default("active"),

  // Migration provenance
  isnSourceId: uuid("isn_source_id"),                                // ISN: id (preserved through migration); unique within account

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byAccount: index("users_account_idx").on(t.accountId),
  byAccountStatus: index("users_account_status_idx").on(t.accountId, t.status),
  byAccountEmail: uniqueIndex("users_account_email_unique").on(t.accountId, t.email),
  byAccountIsnSource: uniqueIndex("users_account_isn_source_unique").on(t.accountId, t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
}));

// =============================================================================
// user_credentials (split from users)
// =============================================================================
// Table: user_credentials
// Security:      Credentials only. passwordHash always encrypted (scrypt). One
//                row per credential type per user (today: 'password'; future:
//                'sso_google', 'sso_microsoft', 'passkey'). Reads of this table
//                produce read_sensitive audit entries (S5). Soft-delete: NO;
//                rotation produces a new row in user_credentials_history. RLS:
//                account-scoped via user FK chain.
// Scalability:   PK on (user_id, kind). Index on (user_id) for the common
//                "fetch all credentials for this user" lookup. Expected row
//                count at 10x: ~60,000 (30,000 users x ~2 credentials avg as
//                SSO and passkeys land).
// Multi-business: SHARED via user. A credential is per user; it works across
//                 every business the user belongs to in their account.
export const userCredentials = pgTable("user_credentials", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 50 }).notNull(),                   // "password" | "sso_google" | "sso_microsoft" | "passkey" (future); see rationale

  // For kind='password': scrypt format `<hex-hash>.<hex-salt>` (current Replit pattern)
  // For SSO: external provider subject identifier (e.g., Google's sub claim).
  // For passkey: WebAuthn credential ID + public key (split into separate columns when implemented).
  secret: text("secret"),                                            // PII: credentials | nullable for SSO/passkey rows that store identifiers in other columns
  externalSubject: varchar("external_subject", { length: 255 }),     // SSO subject identifier; null for password

  // Rotation tracking
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),        // last time this credential was changed; null until first rotation
  requireRotation: boolean("require_rotation").default(false).notNull(),  // forces a rotation on next login

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.kind] }),
  byUser: index("user_credentials_user_idx").on(t.userId),
  byKindSubject: uniqueIndex("user_credentials_kind_subject_unique").on(t.kind, t.externalSubject).where(sql`${t.externalSubject} IS NOT NULL`),
}));

// =============================================================================
// user_security (login security state, separate from credentials)
// =============================================================================
// Table: user_security
// Security:      Login activity, lockout, IP history. PII: IP addresses are PII
//                in some jurisdictions. Read-audit applies. Soft-delete: NO;
//                row exists 1:1 with users.
// Scalability:   PK is user_id (one row per user). Updated on every login
//                attempt. Expected row count at 10x: equals users count.
// Multi-business: SHARED via user. Login activity is per user, not per
//                 business.
export const userSecurity = pgTable("user_security", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),

  // Failed login tracking
  failedLoginCount: integer("failed_login_count").default(0).notNull(),
  lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
  lastFailedLoginIp: varchar("last_failed_login_ip", { length: 64 }),  // PII: address (IP can be PII per GDPR)

  // Successful login tracking
  lastSuccessfulLoginAt: timestamp("last_successful_login_at", { withTimezone: true }),
  lastSuccessfulLoginIp: varchar("last_successful_login_ip", { length: 64 }),  // PII: address
  lastSuccessfulUserAgent: text("last_successful_user_agent"),

  // Lockout
  lockedUntil: timestamp("locked_until", { withTimezone: true }),    // null = not locked
  lockedReason: text("locked_reason"),

  // Password reset enforcement
  requirePasswordReset: boolean("require_password_reset").default(false).notNull(),
  passwordResetTokenHash: varchar("password_reset_token_hash", { length: 255 }),
  passwordResetExpiresAt: timestamp("password_reset_expires_at", { withTimezone: true }),

  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byLockedUntil: index("user_security_locked_until_idx").on(t.lockedUntil),
}));

// =============================================================================
// user_mfa_factors (multi-factor authentication)
// =============================================================================
// Table: user_mfa_factors
// Security:      mfaSecret encrypted at application layer (NOT stored in plain
//                text or DB-encrypted only). Read-audit applies. Soft-delete:
//                NO; revocation is a literal DELETE plus audit_log entry.
//                One user can have multiple factors (e.g., TOTP + backup codes
//                + WebAuthn).
// Scalability:   PK on id. Index on user_id. Expected row count at 10x: ~50,000
//                (most users will have 1-2 factors when MFA enforced).
// Multi-business: SHARED via user. MFA is per user.
export const userMfaFactors = pgTable("user_mfa_factors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),

  kind: varchar("kind", { length: 50 }).notNull(),                   // "totp" | "backup_codes" | "webauthn" | "sms" (future); see rationale
  label: varchar("label", { length: 100 }),                          // user-supplied ("My phone", "Yubikey 5C")

  // For TOTP: encrypted shared secret (application-layer encryption).
  // For WebAuthn: credential public key + ID (split when implemented).
  // For backup_codes: encrypted JSON array of one-time codes.
  secret: text("secret"),                                            // PII: credentials

  enabled: boolean("enabled").default(true).notNull(),               // disabled factors stay for audit but cannot be used
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUser: index("user_mfa_factors_user_idx").on(t.userId),
  byUserEnabled: index("user_mfa_factors_user_enabled_idx").on(t.userId, t.enabled),
}));

// =============================================================================
// user_businesses (membership within account)
// =============================================================================
// Table: user_businesses
// Security:      No PII. RLS: account-scoped through both ends. A user only sees their own memberships and (if admin) memberships of users in businesses they manage within their account.
// Scalability:   PK (user_id, business_id). Index on (business_id) for the "users in business X" query. The user-side lookup is served by the PK leading column. Expected row count at 10x: ~50,000.
// Multi-business: JUNCTION. Adding a new business adds rows here for relevant staff. No schema change.
//
// Pure membership facts only. UI preferences (e.g., which business to land in
// on login) live in a future user_preferences table, NOT here. See rationale
// doc "is_primary moved out of user_businesses" section.
export const userBusinesses = pgTable("user_businesses", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  status: membershipStatusEnum("status").notNull().default("active"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.businessId] }),
  byBusiness: index("user_businesses_business_idx").on(t.businessId),
  // Standalone (user_id) index dropped per review item 8: PK leading column
  // serves user-side lookups.
}));

// =============================================================================
// user_roles (per-business)
// =============================================================================
// Table: user_roles
// Security:      No PII. Sensitive: drives permission decisions. Read-audit applies (S5). Soft-delete: NO; role grants/revocations are mutations recorded in audit_log.
// Scalability:   PK (user_id, business_id, role). Index on (business_id, role). Expected row count at 10x: ~100,000.
// Multi-business: JUNCTION. Same role in different businesses can mean different things. No schema change when a new business is added.
export const userRoles = pgTable("user_roles", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  role: roleEnum("role").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  grantedBy: uuid("granted_by").references(() => users.id),           // null when granted by system seed; see rationale
  expiresAt: timestamp("expires_at", { withTimezone: true }),         // null = permanent; populated = automatic revocation by background job at this time
  expirationReason: text("expiration_reason"),                        // human note ("vacation coverage for Jelai", "project Q3 access")
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.businessId, t.role] }),
  byBusinessRole: index("user_roles_business_role_idx").on(t.businessId, t.role),
  byExpiresAt: index("user_roles_expires_at_idx").on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),  // for the expiration sweep job
}));

// =============================================================================
// Customers (account-scoped, shared across businesses within account)
// =============================================================================
// Table: customers
// Security:      PII heavy (name, email, multiple phones, mailing address). Column-level encryption candidate for email/phone (deterministic encryption or HMAC index for dedupe). Soft-delete: yes (deletedAt/deletedBy/deleteReason). RLS: account-scoped; cross-business access within an account is shared, cross-account is impossible.
// Scalability:   No partition key. Indexes on (account_id, lower(email)), (account_id, lower(display_name)), unique on (account_id, isn_source_id). Expected row count at 10x: 100,000+ within a single account, millions across 50 accounts. Dedupe lookups on email and address are hot.
// Multi-business: SHARED-WITHIN-ACCOUNT. customer_businesses junction tracks which businesses (within the account) have transacted with each customer.
export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),

  firstName: varchar("first_name", { length: 100 }),                 // PII: name
  lastName: varchar("last_name", { length: 100 }),                   // PII: name
  displayName: varchar("display_name", { length: 200 }).notNull(),   // PII: name

  email: varchar("email", { length: 255 }),                          // PII: contact_email
  phoneMobile: varchar("phone_mobile", { length: 50 }),              // PII: phone
  phoneHome: varchar("phone_home", { length: 50 }),                  // PII: phone
  phoneWork: varchar("phone_work", { length: 50 }),                  // PII: phone

  // Mailing address (separate from properties; a customer's mailing address is
  // not necessarily the property being inspected/serviced).
  address1: text("address1"),                                        // PII: address
  address2: text("address2"),                                        // PII: address
  city: varchar("city", { length: 100 }),                            // PII: address
  state: varchar("state", { length: 2 }),                            // PII: address
  zip: varchar("zip", { length: 20 }),                               // PII: address

  notes: text("notes"),                                              // PII: notes (free text)

  smsOptIn: boolean("sms_opt_in").default(false).notNull(),
  emailOptIn: boolean("email_opt_in").default(true).notNull(),

  // Migration provenance
  isnSourceId: uuid("isn_source_id"),
  isnSourceType: varchar("isn_source_type", { length: 50 }),

  status: customerStatusEnum("status").notNull().default("active"),

  // Soft-delete (security spec S4)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => users.id),
  deleteReason: text("delete_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byAccount: index("customers_account_idx").on(t.accountId),
  byAccountEmail: index("customers_account_email_idx").on(t.accountId, sql`lower(${t.email})`),
  byAccountName: index("customers_account_name_idx").on(t.accountId, sql`lower(${t.displayName})`),
  byAccountIsnSource: uniqueIndex("customers_account_isn_source_unique").on(t.accountId, t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
  byDeletedAt: index("customers_deleted_at_idx").on(t.deletedAt),
}));

// customer_businesses junction. "Which businesses (within the account) has this customer used."
// Table: customer_businesses
// Security:      No PII. RLS: account-scoped via both ends.
// Scalability:   PK (customer_id, business_id). Indexes on (business_id), (last_activity_at). Expected row count at 10x: ~150,000 within an account, scaled across accounts.
// Multi-business: JUNCTION.
export const customerBusinesses = pgTable("customer_businesses", {
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
  status: contactRelationshipStatusEnum("status").notNull().default("active"),
}, (t) => ({
  pk: primaryKey({ columns: [t.customerId, t.businessId] }),
  byBusiness: index("customer_businesses_business_idx").on(t.businessId),
  byLastActivity: index("customer_businesses_last_activity_idx").on(t.lastActivityAt),
}));

// =============================================================================
// Properties (account-scoped, shared across businesses within account)
// =============================================================================
// Table: properties
// Security:      PII (address tied to a customer is PII; lat/long is location_precise PII). Encryption candidate for address fields. Soft-delete: yes (deletedAt/deletedBy/deleteReason). RLS: account-scoped.
// Scalability:   No partition key. Indexes on (account_id, zip), (account_id, lower(address1), zip). Expected row count at 10x: 100,000+ within an account.
// Multi-business: SHARED-WITHIN-ACCOUNT. property_businesses junction tracks usage.
export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),

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
  foundation: varchar("foundation", { length: 100 }),                // controlled vocabulary; ISN UUID translated at migration
  occupancy: varchar("occupancy", { length: 100 }),
  propertyType: varchar("property_type", { length: 100 }),

  notes: text("notes"),

  // GAP: dedupe strategy on physical address. Strict match on (address1, city,
  // state, zip) lowercased after normalization, OR a third-party validator on
  // ingest. Decision deferred to 04-field-mapping.md.

  // Soft-delete (security spec S4)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => users.id),
  deleteReason: text("delete_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byAccount: index("properties_account_idx").on(t.accountId),
  byAccountZip: index("properties_account_zip_idx").on(t.accountId, t.zip),
  byAccountAddrLower: index("properties_account_addr_lower_idx").on(t.accountId, sql`lower(${t.address1})`, t.zip),
  byDeletedAt: index("properties_deleted_at_idx").on(t.deletedAt),
}));

// property_businesses junction. "Which businesses have serviced this property."
// Table: property_businesses
// Security:      No PII. RLS: account-scoped via both ends.
// Scalability:   PK (property_id, business_id). Index on (business_id). Expected row count at 10x: ~150,000 within an account.
// Multi-business: JUNCTION.
export const propertyBusinesses = pgTable("property_businesses", {
  propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
  status: contactRelationshipStatusEnum("status").notNull().default("active"),
}, (t) => ({
  pk: primaryKey({ columns: [t.propertyId, t.businessId] }),
  byBusiness: index("property_businesses_business_idx").on(t.businessId),
}));

// customer to property linkage (repeat customers, rentals, etc.)
// Table: customer_properties
// Security:      No direct PII. RLS: account-scoped through both ends.
// Scalability:   PK (customer_id, property_id). Expected row count at 10x: ~120,000 per account.
// Multi-business: SHARED-WITHIN-ACCOUNT.
export const customerProperties = pgTable("customer_properties", {
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  relationship: varchar("relationship", { length: 50 }),             // owner | buyer | seller | renter | manager | other (kept varchar pending Phase 2 evidence)
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.customerId, t.propertyId] }),
}));

// =============================================================================
// Transaction participants (account-scoped, shared across businesses within account)
// =============================================================================
// Table: transaction_participants
// Security:      PII (name, email, phone). Same encryption posture as customers. Soft-delete: yes (deletedAt/deletedBy/deleteReason). RLS: account-scoped.
// Scalability:   No partition key. Indexes on (account_id, email), (account_id, agency_id). Expected row count at 10x: ~50,000 per account.
// Multi-business: SHARED-WITHIN-ACCOUNT. The same realtor can participate in inspections, pool jobs, and pest treatments within the account.
export const transactionParticipants = pgTable("transaction_participants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  agencyId: uuid("agency_id").references(() => agencies.id),

  firstName: varchar("first_name", { length: 100 }),                 // PII: name
  lastName: varchar("last_name", { length: 100 }),                   // PII: name
  displayName: varchar("display_name", { length: 200 }).notNull(),   // PII: name

  email: varchar("email", { length: 255 }),                          // PII: contact_email
  phone: varchar("phone", { length: 50 }),                           // PII: phone
  mobile: varchar("mobile", { length: 50 }),                         // PII: phone

  primaryRole: roleInTransactionEnum("primary_role"),

  notes: text("notes"),

  isnSourceId: uuid("isn_source_id"),
  isnSourceType: varchar("isn_source_type", { length: 50 }),

  status: contactRelationshipStatusEnum("status").notNull().default("active"),

  // Soft-delete (security spec S4)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => users.id),
  deleteReason: text("delete_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byAccount: index("tparticipants_account_idx").on(t.accountId),
  byAccountEmail: index("tparticipants_account_email_idx").on(t.accountId, t.email),
  byAccountAgency: index("tparticipants_account_agency_idx").on(t.accountId, t.agencyId),
  byAccountIsnSource: uniqueIndex("tparticipants_account_isn_source_unique").on(t.accountId, t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
  byDeletedAt: index("tparticipants_deleted_at_idx").on(t.deletedAt),
}));

// =============================================================================
// Agencies (account-scoped, shared across businesses within account)
// =============================================================================
// Table: agencies
// Security:      PII (corporate contact info, not heavy personal). Soft-delete: yes via deletedAt/deletedBy/deleteReason; `active=false` is operational hide. RLS: account-scoped.
// Scalability:   No partition key. Index on (account_id, lower(name)). Expected row count at 10x: ~5,000 per account.
// Multi-business: SHARED-WITHIN-ACCOUNT with agency_businesses junction.
export const agencies = pgTable("agencies", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),

  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 2 }),
  zip: varchar("zip", { length: 20 }),
  notes: text("notes"),
  active: boolean("active").default(true).notNull(),

  isnSourceId: uuid("isn_source_id"),

  // Audit columns
  createdBy: uuid("created_by").notNull().references(() => users.id),
  lastModifiedBy: uuid("last_modified_by").notNull().references(() => users.id),

  // Soft-delete (security spec S4)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => users.id),
  deleteReason: text("delete_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byAccount: index("agencies_account_idx").on(t.accountId),
  byAccountNameLower: index("agencies_account_name_lower_idx").on(t.accountId, sql`lower(${t.name})`),
  byAccountIsnSource: uniqueIndex("agencies_account_isn_source_unique").on(t.accountId, t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
  byDeletedAt: index("agencies_deleted_at_idx").on(t.deletedAt),
}));

// agency_businesses junction
// Table: agency_businesses
// Security:      No PII. RLS: account-scoped via both ends.
// Scalability:   PK (agency_id, business_id). Expected row count at 10x: ~6,000 per account.
// Multi-business: JUNCTION.
export const agencyBusinesses = pgTable("agency_businesses", {
  agencyId: uuid("agency_id").notNull().references(() => agencies.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow().notNull(),
  status: contactRelationshipStatusEnum("status").notNull().default("active"),
}, (t) => ({
  pk: primaryKey({ columns: [t.agencyId, t.businessId] }),
  byBusiness: index("agency_businesses_business_idx").on(t.businessId),
}));

// =============================================================================
// Services (business-scoped; account scope inherited through businesses FK)
// =============================================================================
// Table: services
// Security:      No PII. RLS: account-and-business-scoped via business FK chain. Soft-delete via active=false (low-cardinality config; no PII to wipe).
// Scalability:   Indexes on (business_id), (active). Expected row count at 10x: ~1,000 per account (50 services x 20 businesses average within account).
// Multi-business: SCOPED. Each business has its own service catalog.
export const services = pgTable("services", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),

  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  publicDescription: text("public_description"),

  baseFee: decimal("base_fee", { precision: 10, scale: 2 }).notNull(),
  defaultDurationMinutes: integer("default_duration_minutes").notNull().default(180),
  sequence: integer("sequence").default(100).notNull(),
  active: boolean("active").default(true).notNull(),

  isnSourceId: uuid("isn_source_id"),

  // Audit columns
  createdBy: uuid("created_by").notNull().references(() => users.id),
  lastModifiedBy: uuid("last_modified_by").notNull().references(() => users.id),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byBusiness: index("services_business_idx").on(t.businessId),
  byBusinessActive: index("services_business_active_idx").on(t.businessId, t.active),
  byBusinessIsnSource: uniqueIndex("services_business_isn_source_unique").on(t.businessId, t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
}));

// =============================================================================
// Technician availability (business-scoped; account inherited)
// =============================================================================
// All four tables in this section follow the same scope and RLS pattern. Per
// spec 08 M3, availability is keyed per-business, so a user serving multiple
// businesses has separate hours/time-off/territory/duration overrides per
// business.
//
// Naming open question (spec 08 #2): rename to technician_* to match per-business
// term. Deferred until Troy reviews.

// Table: inspector_hours
// Security:      No PII. RLS: account-and-business-scoped via business FK chain. Soft-delete: NO; rows are deleted/reissued when hours change.
// Scalability:   Indexes on (user_id, business_id). Expected row count at 10x: ~25,000 across all accounts (50 inspectors per account avg × 7 days × 1-2 windows).
// Multi-business: SCOPED. New business onboarding adds rows scoped to that business.
export const inspectorHours = pgTable("inspector_hours", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: varchar("start_time", { length: 5 }).notNull(),
  endTime: varchar("end_time", { length: 5 }).notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  lastModifiedBy: uuid("last_modified_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUserBiz: index("inspector_hours_user_biz_idx").on(t.userId, t.businessId),
}));

// Table: inspector_time_off
// Security:      No PII directly (reason text could in rare cases include sensitive context, e.g., medical leave). Soft-delete: NO; rows are removed when time-off ends or is cancelled.
// Scalability:   Indexes on (user_id, business_id), (starts_at, ends_at). Expected row count at 10x: ~2,500 active windows across all accounts.
// Multi-business: SCOPED. New business onboarding adds rows scoped to that business.
export const inspectorTimeOff = pgTable("inspector_time_off", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  lastModifiedBy: uuid("last_modified_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byUserBiz: index("inspector_time_off_user_biz_idx").on(t.userId, t.businessId),
  byWindow: index("inspector_time_off_window_idx").on(t.startsAt, t.endsAt),
}));

// Table: inspector_zips
// Security:      No PII. RLS: account-and-business-scoped via business FK chain. Soft-delete: NO; territory rows are added/removed directly.
// Scalability:   PK (user_id, business_id, zip). Index on (zip, business_id) for slot computation lookups. Expected row count at 10x: ~50,000 (50 inspectors × 200 ZIPs avg × multi-account).
// Multi-business: SCOPED. New business onboarding adds rows scoped to that business.
export const inspectorZips = pgTable("inspector_zips", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  zip: varchar("zip", { length: 20 }).notNull(),
  priority: integer("priority").default(1).notNull(),                // 1 primary ... 5 will-go-if-needed
  createdBy: uuid("created_by").notNull().references(() => users.id),
  lastModifiedBy: uuid("last_modified_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.businessId, t.zip] }),
  byZipBiz: index("inspector_zips_zip_biz_idx").on(t.zip, t.businessId),
}));

// Table: inspector_service_durations
// Security:      No PII. RLS: account-and-business-scoped via service FK chain (services carries business_id; account inherits).
// Scalability:   PK (user_id, service_id). Expected row count at 10x: ~10,000 (50 inspectors × ~5 services with overrides × multi-account).
// Multi-business: SCOPED via parent service.
export const inspectorServiceDurations = pgTable("inspector_service_durations", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  durationMinutes: integer("duration_minutes").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  lastModifiedBy: uuid("last_modified_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.serviceId] }),
}));

// =============================================================================
// Inspections (business-scoped; account inherited)
// =============================================================================
// Table: inspections
// Security:      PII via FKs (customer, property, participants). Direct PII: special_instructions and internal_notes (free text). Encryption candidate for those notes deferred. Soft-delete: yes (deletedAt/deletedBy/deleteReason). cancelledAt is the operational state distinct from administrative deletion. RLS: account-and-business-scoped via business FK chain.
// Scalability:   PARTITION CANDIDATE on (business_id, scheduled_at) yearly per spec 07 Sc4. Composite indexes lead with business_id (account scope inherited via business FK). Indexes: (business_id, status, scheduled_at), (business_id, lead_inspector_id, scheduled_at), (business_id, customer_id, scheduled_at desc), (business_id, property_id, scheduled_at desc). Expected row count at 10x: ~600,000 cumulative within a single mid-tier account.
// Multi-business: SCOPED. Pattern other operational tables (pool_jobs, pest_treatments) mirror per spec 08 M2.
export const inspections = pgTable("inspections", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),

  // Order number, unique within business.
  // Format: ${businessPrefix}-${currentYear}-${seq:06d}
  // Example: "SH-2026-001234", "HCJ-2026-000045".
  // Generation: a Postgres sequence per business (e.g., order_number_seq_safehouse,
  //   order_number_seq_hcj_pools). Application code calls nextval() and formats
  //   the result with the business prefix and the current year. The sequence
  //   is monotonic across years; year rollover requires no maintenance job.
  // Race-free guarantee: nextval() is atomic in Postgres. Concurrent inserts
  //   never collide.
  // Padding: six digits handles 999,999 per business lifetime. Expand later
  //   trivially by widening the format string.
  // Migration: legacy ISN orderNumber preserved verbatim where it follows our
  //   format; otherwise stored in isnReportNumber and a fresh order number is
  //   generated for the migrated row.
  // See 01-schema-rationale.draft.md for full strategy notes.
  orderNumber: varchar("order_number", { length: 50 }).notNull(),    // unique within business via index below

  // Source tracking
  isnSourceId: uuid("isn_source_id"),
  isnReportNumber: varchar("isn_report_number", { length: 50 }),

  // Scheduling (D3: timestamptz + duration)
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(180),

  // Lead inspector. NULLABLE BY DESIGN. Application logic enforces required-
  // by-status: cannot transition to confirmed | en_route | in_progress |
  // completed without a lead. Three workflow cases require nullability:
  //   1. Booking-before-assignment (client/realtor self-book; dispatcher
  //      assigns later).
  //   2. Cross-business inheritance (future pool_jobs / pest_treatments may
  //      not use a single "lead" concept).
  //   3. Mid-reschedule clearing before reassignment.
  // Multi-inspector via inspection_inspectors junction.
  leadInspectorId: uuid("lead_inspector_id").references(() => users.id),

  // Customer and property (shared within account). Both nullable.
  // - customerId: nullable for migration tolerance (legacy ISN orders may not
  //   link cleanly). Application logic enforces required-by-status: cannot
  //   transition to in_progress | completed without customerId.
  // - propertyId: same migration tolerance, plus a real workflow case
  //   (booking taken before property fully captured; property attaches before
  //   inspection day). Same status enforcement as customerId.
  customerId: uuid("customer_id").references(() => customers.id),
  propertyId: uuid("property_id").references(() => properties.id),

  // Bill-to-closing implementation. NULL means the customer is responsible for
  // payment. When populated, this is the participant (lender, attorney, TC,
  // etc.) who receives the invoice and whose office controls the payment
  // timing. Constrained to a transaction_participants row, which already lives
  // in the inspection_participants junction for this inspection. Application
  // logic should validate the participant IS on inspection_participants before
  // accepting the assignment. See bill-to-closing section in the rationale doc.
  billToParticipantId: uuid("bill_to_participant_id").references(() => transactionParticipants.id),

  // Multi-axis status
  status: inspectionStatusEnum("status").notNull().default("scheduled"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
  signatureStatus: signatureStatusEnum("signature_status").notNull().default("unsigned"),
  qaStatus: qaStatusEnum("qa_status").notNull().default("not_reviewed"),
  reportReleased: boolean("report_released").default(false).notNull(),
  reportReleasedAt: timestamp("report_released_at", { withTimezone: true }),

  // Phase 2 pilot decisions: confirmedAt and initialCompletedAt with their
  // corresponding "by" columns (the actor matters for these events).
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),                    // ISN: confirmeddatetime
  confirmedBy: uuid("confirmed_by").references(() => users.id),                      // null when client self-confirmed via portal
  initialCompletedAt: timestamp("initial_completed_at", { withTimezone: true }),     // ISN: initialcompleteddatetime (distinct from completedAt for QA reopen)
  initialCompletedBy: uuid("initial_completed_by").references(() => users.id),       // who marked first-completion (typically the lead inspector)

  // Finance
  feeAmount: decimal("fee_amount", { precision: 10, scale: 2 }).notNull(),

  // Notes
  specialInstructions: text("special_instructions"),                  // PII: notes (free text)
  internalNotes: text("internal_notes"),                              // PII: notes (free text)

  // Custom fields. Per Phase 2 pilot decision: jsonb on the row, not a separate
  // table. Call-center scripts filtered out at migration. Schema does not
  // constrain shape; per-business expectations documented in
  // shared/schemas/business-config.ts schedulingDefaults section.
  customFields: jsonb("custom_fields").default(sql`'{}'::jsonb`).notNull(),

  // Lifecycle
  // NOTE: rescheduleCount is intentionally NOT a column. Compute from
  // `reschedule_history` via COUNT() when needed. Denormalized counters drift
  // over time. JOIN cost is acceptable with the (inspection_id) index on
  // reschedule_history.
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),                    // ISN: deleteddatetime per platform issue #9
  cancelledBy: uuid("cancelled_by").references(() => users.id),                      // ISN: deletedby
  cancelReason: text("cancel_reason"),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  // Booking source
  source: bookingSourceEnum("source").notNull().default("dispatcher"),
  sourceParticipantId: uuid("source_participant_id").references(() => transactionParticipants.id),

  // Soft-delete (security spec S4). Distinct from cancelledAt operational state.
  // ISN overloads these via deleteddatetime; we keep them separate.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by").references(() => users.id),
  deleteReason: text("delete_reason"),

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
  // Hot-path composites per spec 07 Sc5
  byBizStatusScheduled: index("inspections_biz_status_scheduled_idx").on(t.businessId, t.status, t.scheduledAt),
  byBizInspectorScheduled: index("inspections_biz_inspector_scheduled_idx").on(t.businessId, t.leadInspectorId, t.scheduledAt),
  byBizCustomerScheduledDesc: index("inspections_biz_customer_scheduled_idx").on(t.businessId, t.customerId, t.scheduledAt),
  byBizPropertyScheduledDesc: index("inspections_biz_property_scheduled_idx").on(t.businessId, t.propertyId, t.scheduledAt),
  // Order number unique within business
  byBizOrderNumber: uniqueIndex("inspections_biz_order_number_unique").on(t.businessId, t.orderNumber),
  byBizIsnSource: uniqueIndex("inspections_biz_isn_source_unique").on(t.businessId, t.isnSourceId).where(sql`${t.isnSourceId} IS NOT NULL`),
  byDeletedAt: index("inspections_deleted_at_idx").on(t.deletedAt),
}));

// Multi-inspector orders. One row per assigned inspector beyond the lead.
// Table: inspection_inspectors
// Security:      No PII. RLS: account-and-business-scoped via parent inspections FK.
// Scalability:   PK (inspection_id, inspector_id). Expected row count at 10x: ~30,000 per account (5% of inspections x 1-2 secondaries).
// Multi-business: SCOPED via parent inspections.
export const inspectionInspectors = pgTable("inspection_inspectors", {
  inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
  inspectorId: uuid("inspector_id").notNull().references(() => users.id),
  role: inspectorOnInspectionRoleEnum("role").notNull().default("secondary"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
  assignedBy: uuid("assigned_by").references(() => users.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.inspectionId, t.inspectorId] }),
}));

// Inspection participants
// Table: inspection_participants
// Security:      No direct PII (links transaction_participants which carry PII). RLS: account-and-business-scoped via parent inspections FK.
// Scalability:   PK (inspection_id, participant_id, role_in_transaction). Indexes on (participant_id), (role_in_transaction). Expected row count at 10x: ~600,000 per account.
// Multi-business: SCOPED via parent inspections. The same transaction_participant can appear on inspection_participants for one business AND on a future pool_job_participants for another, since transaction_participants is shared within account.
export const inspectionParticipants = pgTable("inspection_participants", {
  inspectionId: uuid("inspection_id").notNull().references(() => inspections.id, { onDelete: "cascade" }),
  participantId: uuid("participant_id").notNull().references(() => transactionParticipants.id, { onDelete: "restrict" }),
  roleInTransaction: roleInTransactionEnum("role_in_transaction").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.inspectionId, t.participantId, t.roleInTransaction] }),
  byParticipant: index("inspection_participants_participant_idx").on(t.participantId),
  byRole: index("inspection_participants_role_idx").on(t.roleInTransaction),
}));

// Inspection service line items
// Table: inspection_services
// Security:      No PII. RLS: account-and-business-scoped via parent inspections FK.
// Scalability:   Indexes on (inspection_id). Expected row count at 10x: ~1.2M per account.
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
// Security:      No direct PII. RLS: account-and-business-scoped via parent inspections FK.
// Scalability:   Index on (inspection_id). Expected row count at 10x: ~60,000/year per account (10% of inspections reschedule once).
// Multi-business: SCOPED via parent inspections.
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
// audit_log (account-scoped; nullable business_id for cross-business events)
// =============================================================================
// Table: audit_log
// Security:      Append-only. JSON blob `changes` may contain PII snapshots.
//                Application-layer enforces a 64KB max on `changes` payloads;
//                `changesSize` records the actual byte count for monitoring.
//                Encryption candidate for `changes` payload. Soft-delete: NO;
//                data-retention job hard-deletes after configured window. RLS:
//                account-scoped strictly; cross-account leak here =
//                catastrophic.
//                CRITICAL INVARIANT: audit_log.account_id MUST match the
//                account_id of the entity being audited. Not enforced as FK
//                (entity_id is polymorphic). Application-layer guard before
//                every insert. See security spec for explicit enforcement
//                requirement.
// Scalability:   PARTITION CANDIDATE on (account_id, created_at) quarterly per
//                spec 07 Sc4. Highest-write table. Indexes lead with
//                account_id. Expected row count at 10x: ~12M/year per account
//                at full audit posture (writes + read_sensitive). Sizing must
//                account for the read_sensitive multiplier (2-3x base writes).
// Multi-business: SCOPED on account_id (always); business_id nullable for
//                 account-level events. New businesses get their own log
//                 entries; partitioning later separates them physically.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  businessId: uuid("business_id").references(() => businesses.id),    // null for account-level events
  userId: uuid("user_id").references(() => users.id),

  // Forensic correlation
  sessionId: varchar("session_id", { length: 64 }),                   // session correlation; null for pre-auth and system events
  requestId: uuid("request_id"),                                      // correlates all actions within a single HTTP request

  action: auditActionEnum("action").notNull(),
  outcome: auditOutcomeEnum("outcome").notNull().default("success"),  // success | denied | failed | partial

  entityType: varchar("entity_type", { length: 50 }).notNull(),       // CHECK-constrained to AUDIT_ENTITY_TYPES below
  entityId: uuid("entity_id"),

  // Change payload. Application enforces max 64KB. Shape:
  //   { before?: {...}, after?: {...}, metadata?: {...} }
  // - before/after: full or partial entity snapshots, depending on action
  // - metadata: action-specific context (e.g., export filters, override reason)
  changes: jsonb("changes"),                                          // PII: changes (may contain snapshots)
  changesSize: integer("changes_size"),                               // byte count of `changes` for monitoring; populated by application

  ipAddress: inet("ip_address"),                                      // PII: address (IP can be PII per GDPR); native inet for IPv4/IPv6 + CIDR queries
  userAgent: text("user_agent"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byAccountCreatedAt: index("audit_log_account_created_at_idx").on(t.accountId, t.createdAt),
  byEntity: index("audit_log_entity_idx").on(t.entityType, t.entityId),
  byUser: index("audit_log_user_idx").on(t.userId),
  byBusinessCreatedAt: index("audit_log_business_created_at_idx").on(t.businessId, t.createdAt),
  byRequest: index("audit_log_request_idx").on(t.requestId).where(sql`${t.requestId} IS NOT NULL`),
  bySession: index("audit_log_session_idx").on(t.sessionId).where(sql`${t.sessionId} IS NOT NULL`),
  // CHECK constraint enforcing entity_type membership in AUDIT_ENTITY_TYPES.
  // Keeping the column as varchar (no enum migration cost) while gaining
  // DB-layer protection against typos and stale types. Update both this list
  // and AUDIT_ENTITY_TYPES together.
  entityTypeCheck: check(
    "audit_log_entity_type_check",
    sql`entity_type IN (
      'account','business','user','user_credential','user_security','user_mfa_factor','user_business','user_role',
      'customer','property','customer_business','property_business','customer_property','transaction_participant','agency','agency_business',
      'service','inspector_hours','inspector_time_off','inspector_zip','inspector_service_duration',
      'inspection','inspection_inspector','inspection_participant','inspection_service','reschedule_history',
      'login_attempt','session','export_job','system'
    )`
  ),
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
// continue to scope to inspections via existing FKs, so business and
// account context flow through transitively.
//
// `company_settings` is RETIRED. Responsibilities split:
//   - per-business settings move to `businesses.config` jsonb (or columns on businesses)
//   - account-level settings live on `accounts.config`
//
// `territories` table planned but deferred (per Phase 2 augment finding: only
// "Territory A" observed across 15 sampled orders). Will be added when a
// second territory surfaces or when the slot algorithm spec needs it.

// =============================================================================
// Zod insert schemas (subset for draft; full set on lock-in)
// =============================================================================
export const insertAccountSchema = createInsertSchema(accounts).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBusinessSchema = createInsertSchema(businesses).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertUserCredentialSchema = createInsertSchema(userCredentials).omit({ createdAt: true, updatedAt: true });
export const insertUserSecuritySchema = createInsertSchema(userSecurity).omit({ updatedAt: true });
export const insertUserMfaFactorSchema = createInsertSchema(userMfaFactors).omit({ id: true, createdAt: true, updatedAt: true });
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
export const insertInspectorZipSchema = createInsertSchema(inspectorZips).omit({ createdAt: true });
export const insertInspectorServiceDurationSchema = createInsertSchema(inspectorServiceDurations).omit({ createdAt: true });
export const insertInspectionSchema = createInsertSchema(inspections).omit({ id: true, createdAt: true, updatedAt: true, orderNumber: true });
export const insertInspectionInspectorSchema = createInsertSchema(inspectionInspectors).omit({ assignedAt: true });
export const insertInspectionParticipantSchema = createInsertSchema(inspectionParticipants).omit({ createdAt: true });
export const insertInspectionServiceSchema = createInsertSchema(inspectionServices).omit({ id: true, createdAt: true });
export const insertRescheduleHistorySchema = createInsertSchema(rescheduleHistory).omit({ id: true, createdAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLog).omit({ id: true, createdAt: true });

// =============================================================================
// Types
// =============================================================================
export type Account = typeof accounts.$inferSelect;
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Business = typeof businesses.$inferSelect;
export type InsertBusiness = z.infer<typeof insertBusinessSchema>;
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserCredential = typeof userCredentials.$inferSelect;
export type InsertUserCredential = z.infer<typeof insertUserCredentialSchema>;
export type UserSecurity = typeof userSecurity.$inferSelect;
export type InsertUserSecurity = z.infer<typeof insertUserSecuritySchema>;
export type UserMfaFactor = typeof userMfaFactors.$inferSelect;
export type InsertUserMfaFactor = z.infer<typeof insertUserMfaFactorSchema>;
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

// Re-export the config types so callers can import schema + types from one place
export type { AccountConfig, BusinessConfig };
export { accountConfigSchema, businessConfigSchema };
