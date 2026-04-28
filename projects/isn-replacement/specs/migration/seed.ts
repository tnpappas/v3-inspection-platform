/**
 * seed.ts — Step 0: Seed system-managed reference data and seed account.
 *
 * Idempotent: safe to run multiple times. Uses ON CONFLICT DO NOTHING
 * throughout. All counts logged at completion.
 *
 * Run: npx tsx specs/migration/seed.ts
 * Requires: DATABASE_URL env var pointing at the v3.1.2 schema.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, sql } from "drizzle-orm";
import { pool, log, logError } from "./helpers";
import {
  PERMISSIONS_SEED,
  PERMISSION_GROUPS_SEED,
  GROUP_MEMBERS_SEED,
  DEFAULT_ROLE_PERMISSIONS_SEED,
  verifyGroupSensitivityCache,
  verifyAdminAccountAdminInvariant,
  verifyPermissionKeyExistence,
  verifyGroupKeyExistence,
} from "../shared/schemas/permissions-seed";
import {
  accounts,
  users,
  businesses,
  permissions,
  permissionGroups,
  permissionGroupMembers,
  rolePermissions,
  auditLog,
} from "../01-schema";

const db = drizzle(pool, { schema: { accounts, users, businesses, permissions, permissionGroups, permissionGroupMembers, rolePermissions, auditLog } });

const ACCOUNT_SLUG = process.env.SEED_ACCOUNT_SLUG ?? "pappas";
const ACCOUNT_NAME = process.env.SEED_ACCOUNT_NAME ?? "Pappas Group";

async function main() {
  log("seed", "Starting seed migration (idempotent)");

  // ---- Pre-flight: verify seed constant integrity ----
  const sensitivityCheck = verifyGroupSensitivityCache();
  if (!sensitivityCheck.ok) {
    throw new Error(`Group sensitivity cache mismatch: ${JSON.stringify(sensitivityCheck.mismatches)}`);
  }
  const adminCheck = verifyAdminAccountAdminInvariant();
  if (!adminCheck.ok) {
    throw new Error(`admin/account_admin invariant broken: ${JSON.stringify(adminCheck.missing)}`);
  }
  const permKeyCheck = verifyPermissionKeyExistence();
  if (!permKeyCheck.ok) {
    throw new Error(`Unknown permission keys in seed: ${JSON.stringify(permKeyCheck.missing)}`);
  }
  const groupKeyCheck = verifyGroupKeyExistence();
  if (!groupKeyCheck.ok) {
    throw new Error(`Unknown group keys in seed: ${JSON.stringify(groupKeyCheck.missing)}`);
  }
  log("seed", "Pre-flight checks passed");

  // ---- Step 0.1: Permissions ----
  let permInserted = 0;
  for (const perm of PERMISSIONS_SEED) {
    const result = await db
      .insert(permissions)
      .values({ key: perm.key, category: perm.category, description: perm.description, sensitive: perm.sensitive })
      .onConflictDoNothing({ target: permissions.key });
    if (result.rowCount) permInserted++;
  }
  log("seed", `Permissions: ${permInserted} inserted, ${PERMISSIONS_SEED.length - permInserted} already existed`);

  // ---- Step 0.2: Permission groups ----
  let groupInserted = 0;
  for (const group of PERMISSION_GROUPS_SEED) {
    const result = await db
      .insert(permissionGroups)
      .values({ key: group.key, name: group.name, description: group.description, sensitive: group.sensitive })
      .onConflictDoNothing({ target: permissionGroups.key });
    if (result.rowCount) groupInserted++;
  }
  log("seed", `Permission groups: ${groupInserted} inserted, ${PERMISSION_GROUPS_SEED.length - groupInserted} already existed`);

  // ---- Step 0.3: Group memberships ----
  let memberInserted = 0;
  for (const member of GROUP_MEMBERS_SEED) {
    const result = await db
      .insert(permissionGroupMembers)
      .values({ groupKey: member.groupKey, permissionKey: member.permissionKey })
      .onConflictDoNothing();
    if (result.rowCount) memberInserted++;
  }
  log("seed", `Group members: ${memberInserted} inserted, ${GROUP_MEMBERS_SEED.length - memberInserted} already existed`);

  // ---- Step 0.4: Seed account ----
  const existingAccount = await db.query.accounts?.findFirst({
    where: (a, { eq }) => eq(a.slug, ACCOUNT_SLUG),
  });

  let accountId: string;
  if (existingAccount) {
    accountId = existingAccount.id;
    log("seed", `Account already exists: ${accountId}`);
  } else {
    const [newAccount] = await db
      .insert(accounts)
      .values({
        name: ACCOUNT_NAME,
        slug: ACCOUNT_SLUG,
        status: "active",
        planTier: "internal",
        config: {
          security: { requireMfaForOwners: true },
          audit_retention_days: 2555,
        },
        createdBy: null,
        lastModifiedBy: null,
      })
      .returning();
    accountId = newAccount.id;
    log("seed", `Account created: ${accountId}`);
  }

  // ---- Step 0.5: System user ----
  const systemEmail = `system@${ACCOUNT_SLUG}.local`;
  const existingSystem = await db.query.users?.findFirst({
    where: (u, { eq }) => eq(u.email, systemEmail),
  });

  let systemUserId: string;
  if (existingSystem) {
    systemUserId = existingSystem.id;
    log("seed", `System user already exists: ${systemUserId}`);
  } else {
    const [newSystem] = await db
      .insert(users)
      .values({
        accountId,
        email: systemEmail,
        displayName: "System (seed)",
        status: "active",
        isSystem: true,
        passwordHash: null,
      })
      .returning();
    systemUserId = newSystem.id;
    log("seed", `System user created: ${systemUserId}`);
  }

  // Backfill createdBy / lastModifiedBy on account if they were null
  await db
    .update(accounts)
    .set({ createdBy: systemUserId, lastModifiedBy: systemUserId })
    .where(
      and(
        eq(accounts.id, accountId),
        sql`created_by IS NULL`
      )
    );

  // ---- Step 0.6: Businesses ----
  const seedBusinesses = [
    { name: "Safe House Property Inspections", slug: "safehouse", type: "inspection" as const, displayOrder: 1 },
    { name: "HCJ Pool Services",               slug: "hcj-pools",    type: "pool" as const,       displayOrder: 2 },
    { name: "Pest Heroes",                     slug: "pest-heroes",  type: "pest" as const,       displayOrder: 3 },
  ];

  const businessIds: Record<string, string> = {};
  for (const biz of seedBusinesses) {
    const existing = await db.query.businesses?.findFirst({
      where: (b, { eq, and }) => and(eq(b.accountId, accountId), eq(b.slug, biz.slug)),
    });
    if (existing) {
      businessIds[biz.slug] = existing.id;
      log("seed", `Business already exists: ${biz.slug}`);
    } else {
      const [newBiz] = await db
        .insert(businesses)
        .values({
          accountId,
          name: biz.name,
          slug: biz.slug,
          type: biz.type,
          status: "active",
          displayOrder: biz.displayOrder,
          config: {},
          createdBy: systemUserId,
          lastModifiedBy: systemUserId,
        })
        .returning();
      businessIds[biz.slug] = newBiz.id;
      log("seed", `Business created: ${biz.slug} → ${newBiz.id}`);
    }
  }

  // ---- Step 0.7: Order-number sequences ----
  for (const slug of ["safehouse", "hcj_pools", "pest_heroes"]) {
    await pool.query(
      `CREATE SEQUENCE IF NOT EXISTS order_number_seq_${slug} START 1`
    );
  }
  log("seed", "Order-number sequences ensured");

  // ---- Step 0.8: Default role permissions ----
  let rolePermInserted = 0;
  for (const rp of DEFAULT_ROLE_PERMISSIONS_SEED) {
    const result = await db
      .insert(rolePermissions)
      .values({
        accountId,
        role: rp.role,
        permissionKey: rp.permissionKey ?? null,
        groupKey: rp.groupKey ?? null,
        configuredBy: systemUserId,
      })
      .onConflictDoNothing();
    if (result.rowCount) rolePermInserted++;
  }
  log("seed", `Role permissions: ${rolePermInserted} inserted, ${DEFAULT_ROLE_PERMISSIONS_SEED.length - rolePermInserted} already existed`);

  // ---- Step 0.9: Seed audit log entry ----
  const migrationId = "seed-v3.1.2-" + new Date().toISOString().slice(0, 10);
  await db
    .insert(auditLog)
    .values({
      accountId,
      businessId: null,
      userId: systemUserId,
      action: "create",
      outcome: "success",
      entityType: "system",
      changes: {
        metadata: {
          context: "system_seed",
          migration_id: migrationId,
          seeded_counts: {
            permissions: PERMISSIONS_SEED.length,
            permission_groups: PERMISSION_GROUPS_SEED.length,
            group_members: GROUP_MEMBERS_SEED.length,
            businesses: seedBusinesses.length,
            role_permissions: DEFAULT_ROLE_PERMISSIONS_SEED.length,
          },
        },
      },
    })
    .onConflictDoNothing();

  log("seed", `Seed complete. Account: ${accountId}, SystemUser: ${systemUserId}`);
  log("seed", `Business IDs: ${JSON.stringify(businessIds)}`);
  await pool.end();
}

main().catch((err) => {
  logError("seed", "Fatal error", err);
  process.exit(1);
});
