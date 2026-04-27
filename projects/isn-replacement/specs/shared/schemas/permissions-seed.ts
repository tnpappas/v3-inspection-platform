/**
 * PERMISSIONS_SEED, PERMISSION_GROUPS_SEED, GROUP_MEMBERS_SEED, DEFAULT_ROLE_PERMISSIONS_SEED
 *
 * System-managed seed data for the v3.1 RBAC tables. Imported by the seed
 * migration script in `specs/migration/`. Updates to these constants require
 * a migration that diffs against the current state and applies the delta.
 *
 * Convention: `key` values use dot-namespacing (`view.customer.pii`). Group
 * keys are single-segment (`admin`, `view_pii`). Both share a logical
 * namespace but are stored in separate tables.
 *
 * See `01-schema-rationale.md` "Permission system architecture" and
 * `06-security-spec.md` S11 for the design.
 */

import type { Role } from "../../01-schema";

// =============================================================================
// PERMISSIONS_SEED
// =============================================================================
// Categories: "view" | "edit" | "create" | "sensitive" | "config"
// Sensitive flag drives extra audit on grant/revoke and on use.

type PermissionSeedRow = {
  key: string;
  category: "view" | "edit" | "create" | "sensitive" | "config";
  description: string;
  sensitive: boolean;
};

export const PERMISSIONS_SEED: ReadonlyArray<PermissionSeedRow> = [
  // ---- view permissions
  { key: "view.business", category: "view", description: "See business-level data within the active business.", sensitive: false },
  { key: "view.dashboard", category: "view", description: "See the dispatcher dashboard.", sensitive: false },
  { key: "view.calendar", category: "view", description: "See the calendar view.", sensitive: false },
  { key: "view.inspection", category: "view", description: "See inspection records (list and detail).", sensitive: false },
  { key: "view.inspection.internal_notes", category: "view", description: "See internal_notes field on inspections (staff-only notes).", sensitive: true },
  { key: "view.customer", category: "view", description: "See customer records (names visible; PII subject to view.customer.pii).", sensitive: false },
  { key: "view.customer.pii", category: "view", description: "See full customer PII (email, phone, address).", sensitive: true },
  { key: "view.property", category: "view", description: "See property records.", sensitive: false },
  { key: "view.transaction_participant", category: "view", description: "See realtors, attorneys, lenders attached to inspections.", sensitive: false },
  { key: "view.agency", category: "view", description: "See agencies (brokerages, lender institutions, law firms).", sensitive: false },
  { key: "view.user", category: "view", description: "See other users in the business.", sensitive: false },
  { key: "view.user.roles", category: "view", description: "See what roles other users hold.", sensitive: false },
  { key: "view.audit_log", category: "view", description: "See audit log entries.", sensitive: true },
  { key: "view.financial", category: "view", description: "See payment status, fee amounts, invoices.", sensitive: false },
  { key: "view.report", category: "view", description: "See/download released reports.", sensitive: false },
  { key: "view.cross_business", category: "view", description: "See data from other businesses in the account (owner-leaning).", sensitive: false },
  { key: "view.pii", category: "view", description: "Cross-cutting PII access flag (extends view.customer.pii to all PII surfaces).", sensitive: true },

  // ---- edit / create permissions
  { key: "edit.inspection", category: "edit", description: "Update existing inspections (general fields).", sensitive: false },
  { key: "edit.inspection.assign", category: "edit", description: "Assign or reassign lead inspector on an inspection.", sensitive: false },
  { key: "edit.inspection.reschedule", category: "edit", description: "Change scheduled time of an inspection.", sensitive: false },
  { key: "edit.inspection.status", category: "edit", description: "Transition inspection status (en_route, in_progress, completed, etc.).", sensitive: false },
  { key: "edit.customer", category: "edit", description: "Update customer records.", sensitive: false },
  { key: "edit.property", category: "edit", description: "Update property records.", sensitive: false },
  { key: "edit.transaction_participant", category: "edit", description: "Update transaction participants (realtors, etc.).", sensitive: false },
  { key: "edit.agency", category: "edit", description: "Update agencies.", sensitive: false },
  { key: "create.inspection", category: "create", description: "Book a new inspection.", sensitive: false },
  { key: "create.customer", category: "create", description: "Create customer records.", sensitive: false },
  { key: "create.property", category: "create", description: "Create property records.", sensitive: false },
  { key: "create.transaction_participant", category: "create", description: "Add new transaction participants.", sensitive: false },

  // ---- sensitive action permissions
  { key: "cancel.inspection", category: "sensitive", description: "Cancel an inspection (sets status=cancelled).", sensitive: true },
  { key: "delete.inspection", category: "sensitive", description: "Soft-delete inspection (admin action; distinct from cancel).", sensitive: true },
  { key: "release.report", category: "sensitive", description: "Mark report as released to customer.", sensitive: true },
  { key: "override.report_release_gate", category: "sensitive", description: "Release a report despite unmet conditions (paid+signed+uploaded).", sensitive: true },
  { key: "override.no_show_fee", category: "sensitive", description: "Waive the no-show fee on an inspection.", sensitive: true },
  { key: "export.customer_list", category: "sensitive", description: "Bulk export customer data to CSV/PDF.", sensitive: true },
  { key: "export.inspection_list", category: "sensitive", description: "Bulk export inspection data.", sensitive: true },
  { key: "export.financial", category: "sensitive", description: "Bulk export payment/fee data (QuickBooks export, etc.).", sensitive: true },
  { key: "export.audit_log", category: "sensitive", description: "Export audit log entries.", sensitive: true },
  { key: "manage.billing", category: "sensitive", description: "Trigger payment reconciliation, mark paid, handle disputes.", sensitive: true },
  { key: "manage.refund", category: "sensitive", description: "Issue refunds.", sensitive: true },

  // ---- configuration / management permissions
  { key: "manage.user", category: "config", description: "Add/deactivate users in the business.", sensitive: false },
  { key: "manage.user.roles", category: "config", description: "Grant/revoke roles for users in the business.", sensitive: true },
  { key: "manage.user.permissions", category: "config", description: "Grant/revoke per-user permission overrides.", sensitive: true },
  { key: "manage.service", category: "config", description: "Edit services catalog for the business.", sensitive: false },
  { key: "manage.technician_availability", category: "config", description: "Edit any technician's hours, time-off, zips, service-duration overrides.", sensitive: false },
  { key: "manage.business_config", category: "config", description: "Edit businesses.config (notifications, branding, defaults).", sensitive: false },
  { key: "manage.business", category: "config", description: "Activate/deactivate businesses (typically owner-only).", sensitive: true },
  { key: "manage.account_config", category: "config", description: "Edit accounts.config (typically owner-only; includes MFA policy, retention, session lifetime).", sensitive: true },
  { key: "manage.account", category: "config", description: "Add new businesses to account, manage account-level settings.", sensitive: true },
  { key: "manage.permissions_catalog", category: "config", description: "(System-only, not user-grantable) Add/remove from permissions reference table. Reserved for migration code.", sensitive: true },
] as const;

// =============================================================================
// PERMISSION_GROUPS_SEED
// =============================================================================

type PermissionGroupSeedRow = {
  key: string;
  name: string;
  description: string;
  // Sensitive precomputed: TRUE when any contained permission is sensitive.
  // Verified at seed time by recomputePermissionGroupSensitivity().
  sensitive: boolean;
};

export const PERMISSION_GROUPS_SEED: ReadonlyArray<PermissionGroupSeedRow> = [
  {
    key: "admin",
    name: "Admin",
    description: "All manage operations within a business. Excludes account-level operations and system-only permissions.",
    sensitive: true,
  },
  {
    key: "account_admin",
    name: "Account Admin",
    description: "Flat superset of admin plus account-level operations. Owner-leaning. Maintenance rule: when adding a permission to admin, also add to account_admin.",
    sensitive: true,
  },
  {
    key: "view",
    name: "View",
    description: "Read-only across non-sensitive operational surfaces. Excludes PII, financial, audit log, cross-business, internal notes.",
    sensitive: false,
  },
  {
    key: "view_pii",
    name: "View PII",
    description: "Cross-cutting PII access. Granted on top of view.",
    sensitive: true,
  },
  {
    key: "financial",
    name: "Financial",
    description: "View, manage, refund, export financial data.",
    sensitive: true,
  },
  {
    key: "customer_data",
    name: "Customer Data",
    description: "Read and write customer/property/participant records, including PII.",
    sensitive: true,
  },
  {
    key: "operational",
    name: "Operational",
    description: "Day-to-day dispatch and inspection work. Read+edit on inspections, including release.report. Excludes destructive admin and sensitive overrides.",
    sensitive: true,
  },
  {
    key: "audit",
    name: "Audit",
    description: "View and export audit log entries. Investigation/compliance bundle.",
    sensitive: true,
  },
  {
    key: "export",
    name: "Export",
    description: "All bulk export permissions. Sensitive across the board.",
    sensitive: true,
  },
] as const;

// =============================================================================
// GROUP_MEMBERS_SEED
// =============================================================================
// Junction rows mapping each group to its member permissions.
// Maintenance rule for admin/account_admin: when adding a permission to admin,
// also add it to account_admin. A test enforces the invariant.

type GroupMemberSeedRow = {
  groupKey: string;
  permissionKey: string;
};

export const GROUP_MEMBERS_SEED: ReadonlyArray<GroupMemberSeedRow> = [
  // ---- admin
  { groupKey: "admin", permissionKey: "manage.user" },
  { groupKey: "admin", permissionKey: "manage.user.roles" },
  { groupKey: "admin", permissionKey: "manage.user.permissions" },
  { groupKey: "admin", permissionKey: "manage.service" },
  { groupKey: "admin", permissionKey: "manage.technician_availability" },
  { groupKey: "admin", permissionKey: "manage.business_config" },
  { groupKey: "admin", permissionKey: "manage.billing" },
  { groupKey: "admin", permissionKey: "manage.refund" },

  // ---- account_admin (flat superset of admin + account-level)
  { groupKey: "account_admin", permissionKey: "manage.user" },
  { groupKey: "account_admin", permissionKey: "manage.user.roles" },
  { groupKey: "account_admin", permissionKey: "manage.user.permissions" },
  { groupKey: "account_admin", permissionKey: "manage.service" },
  { groupKey: "account_admin", permissionKey: "manage.technician_availability" },
  { groupKey: "account_admin", permissionKey: "manage.business_config" },
  { groupKey: "account_admin", permissionKey: "manage.billing" },
  { groupKey: "account_admin", permissionKey: "manage.refund" },
  { groupKey: "account_admin", permissionKey: "manage.business" },
  { groupKey: "account_admin", permissionKey: "manage.account_config" },
  { groupKey: "account_admin", permissionKey: "manage.account" },

  // ---- view
  { groupKey: "view", permissionKey: "view.business" },
  { groupKey: "view", permissionKey: "view.dashboard" },
  { groupKey: "view", permissionKey: "view.calendar" },
  { groupKey: "view", permissionKey: "view.inspection" },
  { groupKey: "view", permissionKey: "view.customer" },
  { groupKey: "view", permissionKey: "view.property" },
  { groupKey: "view", permissionKey: "view.transaction_participant" },
  { groupKey: "view", permissionKey: "view.agency" },
  { groupKey: "view", permissionKey: "view.user" },
  { groupKey: "view", permissionKey: "view.report" },

  // ---- view_pii
  { groupKey: "view_pii", permissionKey: "view.customer.pii" },
  { groupKey: "view_pii", permissionKey: "view.pii" },

  // ---- financial
  { groupKey: "financial", permissionKey: "view.financial" },
  { groupKey: "financial", permissionKey: "manage.billing" },
  { groupKey: "financial", permissionKey: "manage.refund" },
  { groupKey: "financial", permissionKey: "export.financial" },

  // ---- customer_data
  { groupKey: "customer_data", permissionKey: "view.customer" },
  { groupKey: "customer_data", permissionKey: "view.customer.pii" },
  { groupKey: "customer_data", permissionKey: "view.property" },
  { groupKey: "customer_data", permissionKey: "edit.customer" },
  { groupKey: "customer_data", permissionKey: "edit.property" },
  { groupKey: "customer_data", permissionKey: "create.customer" },
  { groupKey: "customer_data", permissionKey: "create.property" },
  { groupKey: "customer_data", permissionKey: "view.transaction_participant" },
  { groupKey: "customer_data", permissionKey: "edit.transaction_participant" },
  { groupKey: "customer_data", permissionKey: "create.transaction_participant" },

  // ---- operational
  { groupKey: "operational", permissionKey: "view.dashboard" },
  { groupKey: "operational", permissionKey: "view.calendar" },
  { groupKey: "operational", permissionKey: "view.inspection" },
  { groupKey: "operational", permissionKey: "edit.inspection" },
  { groupKey: "operational", permissionKey: "edit.inspection.assign" },
  { groupKey: "operational", permissionKey: "edit.inspection.reschedule" },
  { groupKey: "operational", permissionKey: "edit.inspection.status" },
  { groupKey: "operational", permissionKey: "create.inspection" },
  { groupKey: "operational", permissionKey: "cancel.inspection" },
  { groupKey: "operational", permissionKey: "view.report" },
  { groupKey: "operational", permissionKey: "release.report" },

  // ---- audit
  { groupKey: "audit", permissionKey: "view.audit_log" },
  { groupKey: "audit", permissionKey: "export.audit_log" },

  // ---- export
  { groupKey: "export", permissionKey: "export.customer_list" },
  { groupKey: "export", permissionKey: "export.inspection_list" },
  { groupKey: "export", permissionKey: "export.financial" },
  { groupKey: "export", permissionKey: "export.audit_log" },
] as const;

// =============================================================================
// DEFAULT_ROLE_PERMISSIONS_SEED
// =============================================================================
// Per-account configuration of role defaults. Each account seeds with this
// mapping; owner can adjust later via manage.account_config.
//
// Each entry targets either a permission_key or a group_key (not both).
// Format: { role, permissionKey?, groupKey? }
//
// Note: explicit denies are NOT in role_permissions; denies live on
// user_permission_overrides per the resolution algorithm. Roles only carry
// grants. The "viewer denies" you see in spec 04 are conventions for new
// users, applied as user_permission_overrides at user-creation time when the
// role is granted.

type DefaultRolePermissionRow = {
  role: Role;
  permissionKey?: string;
  groupKey?: string;
};

export const DEFAULT_ROLE_PERMISSIONS_SEED: ReadonlyArray<DefaultRolePermissionRow> = [
  // ----- owner -----
  // All groups granted, plus a few individual permissions. No denies.
  { role: "owner", groupKey: "account_admin" },
  { role: "owner", groupKey: "admin" },
  { role: "owner", groupKey: "view" },
  { role: "owner", groupKey: "view_pii" },
  { role: "owner", groupKey: "financial" },
  { role: "owner", groupKey: "customer_data" },
  { role: "owner", groupKey: "operational" },
  { role: "owner", groupKey: "audit" },
  { role: "owner", groupKey: "export" },
  { role: "owner", permissionKey: "view.cross_business" },
  { role: "owner", permissionKey: "view.user.roles" },
  { role: "owner", permissionKey: "view.inspection.internal_notes" },
  { role: "owner", permissionKey: "override.report_release_gate" },
  { role: "owner", permissionKey: "override.no_show_fee" },
  { role: "owner", permissionKey: "delete.inspection" },

  // ----- operations_manager -----
  { role: "operations_manager", groupKey: "admin" },
  { role: "operations_manager", groupKey: "view" },
  { role: "operations_manager", groupKey: "view_pii" },
  { role: "operations_manager", groupKey: "customer_data" },
  { role: "operations_manager", groupKey: "operational" },
  { role: "operations_manager", groupKey: "export" },
  { role: "operations_manager", permissionKey: "view.user.roles" },
  { role: "operations_manager", permissionKey: "view.inspection.internal_notes" },
  { role: "operations_manager", permissionKey: "release.report" },
  { role: "operations_manager", permissionKey: "override.no_show_fee" },

  // ----- dispatcher -----
  { role: "dispatcher", groupKey: "view" },
  { role: "dispatcher", groupKey: "view_pii" },
  { role: "dispatcher", groupKey: "customer_data" },
  { role: "dispatcher", groupKey: "operational" },

  // ----- technician -----
  // Operational group gives them schedule/status work. Note: scope (own
  // inspections only) is enforced in application code, not here.
  { role: "technician", groupKey: "operational" },
  { role: "technician", permissionKey: "view.business" },
  { role: "technician", permissionKey: "view.report" },
  { role: "technician", permissionKey: "view.customer.pii" },

  // ----- client_success -----
  { role: "client_success", groupKey: "view" },
  { role: "client_success", groupKey: "view_pii" },
  // customer_data is NOT granted in full; client_success can edit customer
  // contact info but not create properties or participants. Express via
  // individual permissions rather than the full customer_data group.
  // view.report is already in the `view` group above; do not duplicate.
  { role: "client_success", permissionKey: "edit.customer" },

  // ----- bookkeeper -----
  // Note: bookkeeper does NOT get view_pii. They see customer names but PII
  // fields are masked at the API serialization layer. The default mapping
  // below intentionally excludes view_pii.
  { role: "bookkeeper", groupKey: "view" },
  { role: "bookkeeper", groupKey: "financial" },
  { role: "bookkeeper", groupKey: "export" },
  { role: "bookkeeper", permissionKey: "view.inspection" },
  { role: "bookkeeper", permissionKey: "view.report" },

  // ----- viewer -----
  // Read-only on the view group. Specific denies (view.customer.pii, etc.) are
  // applied as user_permission_overrides at user-creation time, not here.
  // The role's defaults are minimal.
  { role: "viewer", groupKey: "view" },
] as const;

// =============================================================================
// Helpers used by the seed migration
// =============================================================================

/**
 * Recomputes permission_groups.sensitive for the given groupKey by checking
 * whether any contained permission has sensitive=true. Called by the seed
 * migration after group_members are inserted, and by any future migration
 * that mutates permission_group_members.
 *
 * Implementation contract: the migration script imports this function from
 * `specs/migration/helpers/recompute-sensitivity.ts` (which delegates to
 * Drizzle queries against the live tables).
 */
export type RecomputeGroupSensitivity = (groupKey: string) => Promise<boolean>;

/**
 * For seeded constants only: precomputes group sensitivity from the seed data
 * itself. Useful at compile time for verifying PERMISSION_GROUPS_SEED.sensitive
 * matches GROUP_MEMBERS_SEED contents without needing a database query.
 */
export function precomputeGroupSensitivity(
  permissions: ReadonlyArray<PermissionSeedRow>,
  groupMembers: ReadonlyArray<GroupMemberSeedRow>,
  groupKey: string
): boolean {
  const memberKeys = groupMembers
    .filter((gm) => gm.groupKey === groupKey)
    .map((gm) => gm.permissionKey);
  return permissions.some((p) => memberKeys.includes(p.key) && p.sensitive);
}

/**
 * Verifies that PERMISSION_GROUPS_SEED.sensitive flags match the OR of
 * contained permissions' sensitive flags. Run as a unit test in CI.
 */
export function verifyGroupSensitivityCache(): { ok: boolean; mismatches: Array<{ group: string; expected: boolean; got: boolean }> } {
  const mismatches: Array<{ group: string; expected: boolean; got: boolean }> = [];
  for (const group of PERMISSION_GROUPS_SEED) {
    const expected = precomputeGroupSensitivity(PERMISSIONS_SEED, GROUP_MEMBERS_SEED, group.key);
    if (expected !== group.sensitive) {
      mismatches.push({ group: group.key, expected, got: group.sensitive });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Verifies the admin/account_admin maintenance invariant: every permission in
 * admin must also be in account_admin. Run as a unit test in CI.
 */
export function verifyAdminAccountAdminInvariant(): { ok: boolean; missing: string[] } {
  const adminPerms = new Set(GROUP_MEMBERS_SEED.filter((gm) => gm.groupKey === "admin").map((gm) => gm.permissionKey));
  const accountAdminPerms = new Set(GROUP_MEMBERS_SEED.filter((gm) => gm.groupKey === "account_admin").map((gm) => gm.permissionKey));
  const missing: string[] = [];
  for (const p of adminPerms) {
    if (!accountAdminPerms.has(p)) missing.push(p);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Verifies that every permission_key referenced in GROUP_MEMBERS_SEED,
 * DEFAULT_ROLE_PERMISSIONS_SEED, and ROLE_IMPLICIT_DENIES exists in
 * PERMISSIONS_SEED. Catches typos in group memberships and role mappings.
 * Run as a unit test in CI.
 */
export function verifyPermissionKeyExistence(): { ok: boolean; missing: string[] } {
  const validKeys = new Set(PERMISSIONS_SEED.map((p) => p.key));
  const missing = new Set<string>();

  for (const gm of GROUP_MEMBERS_SEED) {
    if (!validKeys.has(gm.permissionKey)) missing.add(gm.permissionKey);
  }
  for (const rp of DEFAULT_ROLE_PERMISSIONS_SEED) {
    if (rp.permissionKey && !validKeys.has(rp.permissionKey)) missing.add(rp.permissionKey);
  }
  for (const rd of ROLE_IMPLICIT_DENIES) {
    if (!validKeys.has(rd.permissionKey)) missing.add(rd.permissionKey);
  }

  return { ok: missing.size === 0, missing: Array.from(missing).sort() };
}

/**
 * Verifies that every group_key referenced in GROUP_MEMBERS_SEED and
 * DEFAULT_ROLE_PERMISSIONS_SEED exists in PERMISSION_GROUPS_SEED. Catches
 * typos in group memberships and role mappings. Run as a unit test in CI.
 */
export function verifyGroupKeyExistence(): { ok: boolean; missing: string[] } {
  const validKeys = new Set(PERMISSION_GROUPS_SEED.map((g) => g.key));
  const missing = new Set<string>();

  for (const gm of GROUP_MEMBERS_SEED) {
    if (!validKeys.has(gm.groupKey)) missing.add(gm.groupKey);
  }
  for (const rp of DEFAULT_ROLE_PERMISSIONS_SEED) {
    if (rp.groupKey && !validKeys.has(rp.groupKey)) missing.add(rp.groupKey);
  }

  return { ok: missing.size === 0, missing: Array.from(missing).sort() };
}

// =============================================================================
// ROLE_IMPLICIT_DENIES
// =============================================================================
// Per `06-security-spec.md` S11 "Implicit role denies pattern": role conventions
// that should be denied at user-creation time are seeded as user_permission_overrides
// rows with effect='deny', NOT as role_permissions rows.
//
// When a user is created and granted a role, the application:
//   1. Inserts the user_roles row.
//   2. Looks up implicit denies for that role from this constant.
//   3. Inserts a user_permission_overrides row per implicit deny.
//
// Adding a role or changing implicit denies updates this constant and triggers
// a migration that retroactively applies new denies to existing users.
//
// CI test verifyPermissionKeyExistence() asserts every implicit deny references
// a valid permission key.

type RoleImplicitDeny = {
  role: Role;
  permissionKey: string;
  reason: string;  // becomes the `reason` field on the user_permission_overrides row
};

export const ROLE_IMPLICIT_DENIES: ReadonlyArray<RoleImplicitDeny> = [
  // ----- bookkeeper -----
  // Bookkeeper sees customer names but not PII details. Defense-in-depth deny
  // even though the default role does not include view_pii (the deny stays in
  // place if a future change adds PII to the view group).
  { role: "bookkeeper", permissionKey: "view.customer.pii", reason: "role default deny: bookkeeper PII restriction" },
  { role: "bookkeeper", permissionKey: "view.user.roles", reason: "role default deny: bookkeeper does not need role visibility" },
  { role: "bookkeeper", permissionKey: "view.audit_log", reason: "role default deny: bookkeeper audit access requires explicit grant per S11" },
  { role: "bookkeeper", permissionKey: "view.cross_business", reason: "role default deny: bookkeeper scoped to active business" },
  { role: "bookkeeper", permissionKey: "view.inspection.internal_notes", reason: "role default deny: bookkeeper does not see internal notes" },

  // ----- viewer -----
  // Read-only across the business. All write/delete/admin operations denied.
  { role: "viewer", permissionKey: "view.customer.pii", reason: "role default deny: viewer no PII" },
  { role: "viewer", permissionKey: "view.financial", reason: "role default deny: viewer no financial" },
  { role: "viewer", permissionKey: "view.audit_log", reason: "role default deny: viewer no audit" },
  { role: "viewer", permissionKey: "view.cross_business", reason: "role default deny: viewer scoped to active business" },
  { role: "viewer", permissionKey: "view.inspection.internal_notes", reason: "role default deny: viewer no internal notes" },
  { role: "viewer", permissionKey: "edit.inspection", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "edit.inspection.assign", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "edit.inspection.reschedule", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "edit.inspection.status", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "edit.customer", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "edit.property", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "edit.transaction_participant", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "edit.agency", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "create.inspection", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "create.customer", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "create.property", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "create.transaction_participant", reason: "role default deny: viewer is read-only" },
  { role: "viewer", permissionKey: "cancel.inspection", reason: "role default deny: viewer no cancellation" },
  { role: "viewer", permissionKey: "delete.inspection", reason: "role default deny: viewer no delete" },

  // ----- client_success -----
  // Client success handles customer support; cannot create or destructively act
  // on records. The grant set already excludes most of these, but explicit denies
  // ensure defense-in-depth.
  { role: "client_success", permissionKey: "delete.inspection", reason: "role default deny: client_success cannot delete" },
  { role: "client_success", permissionKey: "cancel.inspection", reason: "role default deny: client_success cannot cancel; dispatcher work" },
  { role: "client_success", permissionKey: "create.inspection", reason: "role default deny: client_success cannot create inspections; dispatcher work" },
  { role: "client_success", permissionKey: "create.customer", reason: "role default deny: client_success cannot create customers; dispatcher work" },
  { role: "client_success", permissionKey: "create.property", reason: "role default deny: client_success cannot create properties; dispatcher work" },
] as const;
