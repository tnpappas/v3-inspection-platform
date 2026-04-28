/**
 * migrate-users.ts — Step 1: User audit and import.
 *
 * Pulls all 296 ISN users, classifies each via classifyIsnUser(), and imports
 * them with user_roles and implicit deny overrides. Idempotent via isnSourceId
 * upsert.
 *
 * Run: npx tsx specs/migration/migrate-users.ts
 * Output: migration/user-classification.csv (gitignored, PII)
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import {
  pool,
  log,
  logError,
  isnGet,
  coerceIsnBoolean,
  normalizeIsnString,
  parseIsnDatetime,
  DEFAULT_ROLE_MAPPING,
  PerAccountConfig,
  Role,
  writeCsvHeader,
  writeCsvLine,
} from "./helpers";
import {
  users,
  userCredentials,
  userBusinesses,
  userRoles,
  userPermissionOverrides,
  auditLog,
} from "../01-schema";
import { ROLE_IMPLICIT_DENIES } from "../shared/schemas/permissions-seed";

const db = drizzle(pool, { schema: { users, userCredentials, userBusinesses, userRoles, userPermissionOverrides, auditLog } });

const MIGRATION_DIR = "migration";
const CSV_PATH = `${MIGRATION_DIR}/user-classification.csv`;

interface ISNUser {
  id: string;
  username: string;
  firstname?: string;
  lastname?: string;
  displayname?: string;
  emailaddress?: string;
  phone?: string;
  mobile?: string;
  fax?: string;
  address1?: string;
  address2?: string;
  city?: string;
  stateabbreviation?: string;
  zip?: string;
  county?: string;
  license?: string;
  licensetype?: string;
  bio?: string;
  photourl?: string;
  sendSMS?: string;
  inspector?: string;
  owner?: string;
  manager?: string;
  officestaff?: string;
  callcenter?: string;
  thirdparty?: string;
  show?: string;
  modified?: string;
  zips?: string[];
}

type BusinessSlug = "safehouse" | "hcj-pools" | "pest-heroes";

interface UserClassification {
  isnUserId: string;
  isnUsername: string;
  importAs: "active" | "inactive" | "skip";
  businesses: Array<{ slug: BusinessSlug; roles: Role[] }>;
  reasoning: string;
}

function classifyIsnUser(
  user: ISNUser,
  config: PerAccountConfig
): UserClassification {
  const mapping = { ...DEFAULT_ROLE_MAPPING, ...config.roleMapping };
  const isActive = coerceIsnBoolean(user.show);
  const roles: Role[] = [];

  if (coerceIsnBoolean(user.inspector) && mapping.inspector) roles.push(mapping.inspector);
  if (coerceIsnBoolean(user.owner)    && mapping.owner)     roles.push(mapping.owner);
  if (coerceIsnBoolean(user.manager)  && mapping.manager)   roles.push(mapping.manager);
  if (coerceIsnBoolean(user.officestaff) && mapping.officestaff) roles.push(mapping.officestaff);
  if (coerceIsnBoolean(user.callcenter)  && mapping.callcenter)  roles.push(mapping.callcenter);
  if (coerceIsnBoolean(user.thirdparty)  && mapping.thirdparty)  roles.push(mapping.thirdparty);

  // Remove duplicates
  const uniqueRoles = [...new Set(roles)];

  if (uniqueRoles.length === 0) {
    return {
      isnUserId: user.id,
      isnUsername: user.username,
      importAs: "skip",
      businesses: [],
      reasoning: "No role flags set to Yes",
    };
  }

  // Owner-flagged users belong to all three businesses
  const isOwner = uniqueRoles.includes("owner");

  const targetBusinesses: Array<{ slug: BusinessSlug; roles: Role[] }> = isOwner
    ? [
        { slug: "safehouse",   roles: uniqueRoles },
        { slug: "hcj-pools",   roles: uniqueRoles },
        { slug: "pest-heroes", roles: uniqueRoles },
      ]
    : [{ slug: "safehouse", roles: uniqueRoles }];

  return {
    isnUserId: user.id,
    isnUsername: user.username,
    importAs: isActive ? "active" : "inactive",
    businesses: targetBusinesses,
    reasoning: `Flags: ${uniqueRoles.join(",")}; show=${user.show}`,
  };
}

async function getOrCreateSystemUser(accountId: string): Promise<string> {
  const systemEmail = `system@${process.env.SEED_ACCOUNT_SLUG ?? "pappas"}.local`;
  const existing = await db.query.users?.findFirst({
    where: (u, { eq }) => eq(u.email, systemEmail),
  });
  if (!existing) throw new Error("System user not found. Run seed.ts first.");
  return existing.id;
}

async function main() {
  log("migrate-users", "Starting user migration");

  const ACCOUNT_ID = process.env.MIGRATION_ACCOUNT_ID;
  const SAFEHOUSE_BIZ_ID = process.env.MIGRATION_SAFEHOUSE_BIZ_ID;
  const HCJ_BIZ_ID = process.env.MIGRATION_HCJ_BIZ_ID;
  const PEST_BIZ_ID = process.env.MIGRATION_PEST_BIZ_ID;
  if (!ACCOUNT_ID || !SAFEHOUSE_BIZ_ID || !HCJ_BIZ_ID || !PEST_BIZ_ID) {
    throw new Error("Set MIGRATION_ACCOUNT_ID, MIGRATION_SAFEHOUSE_BIZ_ID, MIGRATION_HCJ_BIZ_ID, MIGRATION_PEST_BIZ_ID env vars");
  }

  const bizIdBySlug: Record<BusinessSlug, string> = {
    "safehouse":   SAFEHOUSE_BIZ_ID,
    "hcj-pools":   HCJ_BIZ_ID,
    "pest-heroes": PEST_BIZ_ID,
  };

  const systemUserId = await getOrCreateSystemUser(ACCOUNT_ID);
  const config: PerAccountConfig = { accountSlug: process.env.SEED_ACCOUNT_SLUG ?? "pappas" };

  // Pull ISN users
  const response = await isnGet<{ users: ISNUser[] }>("/users");
  const isnUsers = response.users;
  log("migrate-users", `Pulled ${isnUsers.length} ISN users`);

  // Set up CSV
  writeCsvHeader(CSV_PATH, [
    "isn_user_id", "isn_username", "import_as", "businesses", "roles", "v3_user_id", "reasoning",
  ]);

  let imported = 0, updated = 0, skipped = 0;

  for (const isnUser of isnUsers) {
    const classification = classifyIsnUser(isnUser, config);

    if (classification.importAs === "skip") {
      writeCsvLine(CSV_PATH, {
        isn_user_id: isnUser.id,
        isn_username: isnUser.username,
        import_as: "skip",
        businesses: "",
        roles: "",
        v3_user_id: "",
        reasoning: classification.reasoning,
      });
      skipped++;
      continue;
    }

    const displayName = normalizeIsnString(isnUser.displayname)
      ?? [isnUser.firstname, isnUser.lastname].filter(Boolean).join(" ")
      || isnUser.username;

    const userPayload = {
      accountId: ACCOUNT_ID,
      email: normalizeIsnString(isnUser.emailaddress) ?? `${isnUser.username}@migrated.local`,
      username: normalizeIsnString(isnUser.username),
      firstName: normalizeIsnString(isnUser.firstname),
      lastName: normalizeIsnString(isnUser.lastname),
      displayName,
      phone: normalizeIsnString(isnUser.phone),
      mobile: normalizeIsnString(isnUser.mobile),
      address1: normalizeIsnString(isnUser.address1),
      address2: normalizeIsnString(isnUser.address2),
      city: normalizeIsnString(isnUser.city),
      state: normalizeIsnString(isnUser.stateabbreviation),
      zip: normalizeIsnString(isnUser.zip),
      county: normalizeIsnString(isnUser.county),
      license: normalizeIsnString(isnUser.license),
      licenseType: normalizeIsnString(isnUser.licensetype),
      bio: normalizeIsnString(isnUser.bio),
      photoUrl: normalizeIsnString(isnUser.photourl),
      smsOptIn: coerceIsnBoolean(isnUser.sendSMS),
      emailOptIn: true,
      status: classification.importAs === "active" ? "active" as const : "inactive" as const,
      isSystem: false,
      isnSourceId: isnUser.id,
    };

    // Upsert user
    const existing = await db.query.users?.findFirst({
      where: (u, { eq, and }) => and(eq(u.accountId, ACCOUNT_ID), eq(u.isnSourceId, isnUser.id)),
    });

    let v3UserId: string;
    if (existing) {
      await db.update(users).set(userPayload).where(eq(users.id, existing.id));
      v3UserId = existing.id;
      updated++;
    } else {
      const [created] = await db.insert(users).values(userPayload).returning();
      v3UserId = created.id;

      // Credentials row: password null, requireRotation=true (must reset on first login)
      await db.insert(userCredentials).values({
        userId: v3UserId,
        kind: "password",
        secret: null,
        requireRotation: true,
      }).onConflictDoNothing();

      imported++;
    }

    // Upsert user_businesses and user_roles
    for (const biz of classification.businesses) {
      const bizId = bizIdBySlug[biz.slug];

      await db.insert(userBusinesses).values({
        userId: v3UserId,
        businessId: bizId,
        status: "active",
      }).onConflictDoNothing();

      for (const role of biz.roles) {
        await db.insert(userRoles).values({
          userId: v3UserId,
          businessId: bizId,
          role,
          grantedBy: systemUserId,
        }).onConflictDoNothing();

        // Apply implicit role denies
        const implicitDenies = ROLE_IMPLICIT_DENIES.filter((d) => d.role === role);
        for (const deny of implicitDenies) {
          await db.insert(userPermissionOverrides).values({
            userId: v3UserId,
            businessId: bizId,
            permissionKey: deny.permissionKey,
            groupKey: null,
            effect: "deny",
            reason: deny.reason,
            grantedBy: systemUserId,
          }).onConflictDoNothing();
        }
      }
    }

    writeCsvLine(CSV_PATH, {
      isn_user_id: isnUser.id,
      isn_username: isnUser.username,
      import_as: classification.importAs,
      businesses: classification.businesses.map((b) => b.slug).join(";"),
      roles: classification.businesses.map((b) => b.roles.join(",")).join(";"),
      v3_user_id: v3UserId,
      reasoning: classification.reasoning,
    });
  }

  log("migrate-users", `Done. Imported: ${imported}, Updated: ${updated}, Skipped: ${skipped}`);
  log("migrate-users", `Classification CSV: ${CSV_PATH}`);
  await pool.end();
}

main().catch((err) => {
  logError("migrate-users", "Fatal", err);
  process.exit(1);
});
