/**
 * migrate-contacts.ts — Step 2: Contact split and import.
 *
 * Pulls ISN clients, agents, escrow officers, insurance agents.
 * Routes each to customers or transaction_participants per spec 04/05.
 * Also reconstructs agencies from denormalized agent data.
 * Idempotent via isnSourceId upsert.
 *
 * Run: npx tsx specs/migration/migrate-contacts.ts
 * Output: migration/contact-classification.csv (gitignored, PII)
 *         migration/contact-dedup.csv (gitignored, PII)
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import * as fs from "fs";
import {
  pool,
  log,
  logError,
  isnGetThrottled,
  coerceIsnBoolean,
  normalizeIsnString,
  customerDedupeKey,
  writeCsvHeader,
  writeCsvLine,
  PerAccountConfig,
} from "./helpers";
import {
  agencies,
  agencyBusinesses,
  customers,
  customerBusinesses,
  transactionParticipants,
  users,
} from "../01-schema";

const db = drizzle(pool, {
  schema: { agencies, agencyBusinesses, customers, customerBusinesses, transactionParticipants, users },
});

const CONTACT_CSV = "migration/contact-classification.csv";
const DEDUP_CSV = "migration/contact-dedup.csv";
/** Checkpoint file: records ISN agent IDs that have been fully processed. */
const CHECKPOINT_FILE = "migration/migrate-contacts-checkpoint.json";

function loadCheckpoint(): Set<string> {
  if (!fs.existsSync(CHECKPOINT_FILE)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8")) as string[];
    return new Set(data);
  } catch {
    return new Set();
  }
}

function saveCheckpoint(done: Set<string>): void {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify([...done], null, 2), "utf8");
}

async function importAgencies(
  agentList: Array<{ id: string; show?: string; agency?: string; modified?: string }>,
  accountId: string,
  safeHouseBizId: string,
  systemUserId: string
): Promise<Map<string, string>> {
  /** Returns map from ISN agency UUID → v3 agency UUID */
  const agencyMap = new Map<string, string>();
  const seen = new Set<string>();

  for (const agent of agentList) {
    const isnAgencyId = agent.agency as string | undefined;
    if (!isnAgencyId || seen.has(isnAgencyId)) continue;
    seen.add(isnAgencyId);

    // We only have the UUID from the stub; pull full agent to get agency name
    // For now we use the UUID as a placeholder name; the deep-crawl in migration
    // prep (open question #6) will fill the real name.
    const existing = await db.query.agencies?.findFirst({
      where: (a, { and, eq }) => and(eq(a.accountId, accountId), eq(a.isnSourceId, isnAgencyId)),
    });

    if (existing) {
      agencyMap.set(isnAgencyId, existing.id);
      continue;
    }

    const [newAgency] = await db
      .insert(agencies)
      .values({
        accountId,
        name: `ISN Agency ${isnAgencyId.slice(0, 8)}`, // placeholder; overwritten after full crawl
        active: true,
        isnSourceId: isnAgencyId,
        createdBy: systemUserId,
        lastModifiedBy: systemUserId,
      })
      .returning();

    await db
      .insert(agencyBusinesses)
      .values({ agencyId: newAgency.id, businessId: safeHouseBizId })
      .onConflictDoNothing();

    agencyMap.set(isnAgencyId, newAgency.id);
  }

  log("migrate-contacts", `Agencies: ${agencyMap.size} processed`);
  return agencyMap;
}

async function main() {
  log("migrate-contacts", "Starting contact migration");

  const ACCOUNT_ID = process.env.MIGRATION_ACCOUNT_ID;
  const SAFEHOUSE_BIZ_ID = process.env.MIGRATION_SAFEHOUSE_BIZ_ID;
  const RESUME = process.env.RESUME === "true";
  if (!ACCOUNT_ID || !SAFEHOUSE_BIZ_ID) {
    throw new Error("Set MIGRATION_ACCOUNT_ID and MIGRATION_SAFEHOUSE_BIZ_ID env vars");
  }

  // Resolve system user via Drizzle (consistent with rest of codebase)
  const systemEmail = `system@${process.env.SEED_ACCOUNT_SLUG ?? "pappas"}.local`;
  const systemUserRow = await db.query.users?.findFirst({
    where: (u, { eq }) => eq(u.email, systemEmail),
  });
  const systemUserId = systemUserRow?.id;
  if (!systemUserId) throw new Error("System user not found. Run seed.ts first.");

  const checkpoint = RESUME ? loadCheckpoint() : new Set<string>();
  if (RESUME) log("migrate-contacts", `Resuming: ${checkpoint.size} agents already processed`);

  writeCsvHeader(CONTACT_CSV, [
    "isn_source_type", "isn_id", "isn_name", "routed_to", "v3_id", "reason",
  ]);
  writeCsvHeader(DEDUP_CSV, [
    "isn_source_type", "isn_id", "isn_name", "isn_email", "dedup_key", "merged_into_v3_id",
  ]);

  // ---- Agents (→ transaction_participants) ----
  const agentsResponse = await isnGetThrottled<{ agents: Array<{ id: string; show?: string; modified?: string }> }>("/agents");
  const agentStubs = agentsResponse.agents;
  log("migrate-contacts", `Agent stubs: ${agentStubs.length}`);

  // For Phase 2 we have stubs only. Full agent detail pull happens here.
  // Throttled: 400ms between calls.
  let agentsImported = 0, agentsUpdated = 0;
  const agencyMap = new Map<string, string>();

  for (const stub of agentStubs) {
    // Skip if already processed (resume-from-checkpoint)
    if (checkpoint.has(stub.id)) continue;

    const detail = await isnGetThrottled<{ agent?: Record<string, unknown> }>(`/agent/${stub.id}`)
      .catch(() => null);
    if (!detail?.agent) { checkpoint.add(stub.id); continue; }

    const a = detail.agent as Record<string, string | string[] | null>;
    const isnAgencyId = a.agency as string | null;

    // Reconstruct agency if needed
    if (isnAgencyId && !agencyMap.has(isnAgencyId)) {
      const existingAgency = await db.query.agencies?.findFirst({
        where: (ag, { and, eq }) => and(eq(ag.accountId, ACCOUNT_ID), eq(ag.isnSourceId, isnAgencyId)),
      });
      if (existingAgency) {
        agencyMap.set(isnAgencyId, existingAgency.id);
      } else {
        const [newAg] = await db.insert(agencies).values({
          accountId: ACCOUNT_ID,
          name: `ISN Agency ${isnAgencyId.slice(0, 8)}`,
          active: true,
          isnSourceId: isnAgencyId,
          createdBy: systemUserId,
          lastModifiedBy: systemUserId,
        }).returning();
        await db.insert(agencyBusinesses).values({ agencyId: newAg.id, businessId: SAFEHOUSE_BIZ_ID }).onConflictDoNothing();
        agencyMap.set(isnAgencyId, newAg.id);
      }
    }

    const displayName = normalizeIsnString(a.displayname as string)
      ?? [a.firstname, a.lastname].filter(Boolean).join(" ")
      ?? "Unknown Agent";

    const existing = await db.query.transactionParticipants?.findFirst({
      where: (tp, { and, eq }) => and(eq(tp.accountId, ACCOUNT_ID), eq(tp.isnSourceId, stub.id)),
    });

    const payload = {
      accountId: ACCOUNT_ID,
      agencyId: isnAgencyId ? agencyMap.get(isnAgencyId) ?? null : null,
      displayName,
      firstName: normalizeIsnString(a.firstname as string),
      lastName: normalizeIsnString(a.lastname as string),
      email: normalizeIsnString(a.emailaddress as string),
      phone: normalizeIsnString(a.phone as string),
      mobile: normalizeIsnString(a.mobile as string),
      primaryRole: null, // derived in post-pass (Step 7)
      status: coerceIsnBoolean(a.show as string) ? "active" as const : "inactive" as const,
      isnSourceId: stub.id,
      isnSourceType: "agent",
    };

    let v3Id: string;
    if (existing) {
      await db.update(transactionParticipants).set(payload).where(eq(transactionParticipants.id, existing.id));
      v3Id = existing.id;
      agentsUpdated++;
    } else {
      const [created] = await db.insert(transactionParticipants).values(payload).returning();
      v3Id = created.id;
      agentsImported++;
    }

    writeCsvLine(CONTACT_CSV, {
      isn_source_type: "agent",
      isn_id: stub.id,
      isn_name: displayName,
      routed_to: "transaction_participants",
      v3_id: v3Id,
      reason: "ISN agent → transaction_participant",
    });

    // Mark as done and save checkpoint every 50 agents
    checkpoint.add(stub.id);
    if (checkpoint.size % 50 === 0) {
      saveCheckpoint(checkpoint);
      log("migrate-contacts", `Checkpoint saved: ${checkpoint.size} agents processed`);
    }
  }
  saveCheckpoint(checkpoint);
  log("migrate-contacts", `Agents: ${agentsImported} imported, ${agentsUpdated} updated`);

  // ---- Clients (→ customers) ----
  // Full client crawl: pull stubs then detail.
  const clientsResponse = await isnGetThrottled<{ clients?: Array<{ id: string }>, count?: number }>(
    "/clients"
  );
  const clientStubs = clientsResponse.clients ?? [];
  log("migrate-contacts", `Client stubs: ${clientStubs.length}`);

  // Dedupe map: dedup_key → v3 customer id (first-seen wins)
  const clientDedupeMap = new Map<string, string>();
  let clientsImported = 0, clientsUpdated = 0, clientsMerged = 0;

  for (const stub of clientStubs) {
    const detail = await isnGetThrottled<{ client?: Record<string, unknown> }>(`/client/${stub.id}`)
      .catch(() => null);
    if (!detail?.client) continue;

    const c = detail.client as Record<string, string | null>;
    const displayName = normalizeIsnString(c.displayname)
      ?? [c.firstname, c.lastname].filter(Boolean).join(" ")
      ?? "Unknown Client";
    const email = normalizeIsnString(c.emailaddress);
    const dedup = customerDedupeKey({ email, displayName });

    // Check existing by isnSourceId first
    const existingByIsn = await db.query.customers?.findFirst({
      where: (cu, { and, eq }) => and(eq(cu.accountId, ACCOUNT_ID), eq(cu.isnSourceId, stub.id)),
    });

    if (existingByIsn) {
      // Already imported; update fields
      await db.update(customers).set({
        displayName,
        firstName: normalizeIsnString(c.firstname),
        lastName: normalizeIsnString(c.lastname),
        email,
        phoneMobile: normalizeIsnString(c.phonemobile),
        phoneHome: normalizeIsnString(c.phonehome),
      }).where(eq(customers.id, existingByIsn.id));
      clientDedupeMap.set(dedup, existingByIsn.id);
      clientsUpdated++;
      continue;
    }

    // Check dedup
    if (clientDedupeMap.has(dedup)) {
      const mergedIntoId = clientDedupeMap.get(dedup)!;
      writeCsvLine(DEDUP_CSV, {
        isn_source_type: "client",
        isn_id: stub.id,
        isn_name: displayName,
        isn_email: email ?? "",
        dedup_key: dedup,
        merged_into_v3_id: mergedIntoId,
      });
      clientsMerged++;
      continue;
    }

    const [created] = await db.insert(customers).values({
      accountId: ACCOUNT_ID,
      displayName,
      firstName: normalizeIsnString(c.firstname),
      lastName: normalizeIsnString(c.lastname),
      email,
      phoneMobile: normalizeIsnString(c.phonemobile),
      phoneHome: normalizeIsnString(c.phonehome),
      phoneWork: normalizeIsnString(c.phonework),
      address1: normalizeIsnString(c.address1),
      city: normalizeIsnString(c.city),
      state: normalizeIsnString(c.stateabbreviation),
      zip: normalizeIsnString(c.zip),
      smsOptIn: coerceIsnBoolean(c.sendSMS),
      emailOptIn: true,
      status: coerceIsnBoolean(c.show) ? "active" as const : "inactive" as const,
      isnSourceId: stub.id,
      isnSourceType: "client",
    }).returning();

    await db.insert(customerBusinesses).values({
      customerId: created.id,
      businessId: SAFEHOUSE_BIZ_ID,
    }).onConflictDoNothing();

    clientDedupeMap.set(dedup, created.id);
    clientsImported++;

    writeCsvLine(CONTACT_CSV, {
      isn_source_type: "client",
      isn_id: stub.id,
      isn_name: displayName,
      routed_to: "customers",
      v3_id: created.id,
      reason: "ISN client → customer",
    });
  }

  log("migrate-contacts", `Clients: ${clientsImported} imported, ${clientsUpdated} updated, ${clientsMerged} merged`);
  log("migrate-contacts", "Migration complete");
  await pool.end();
}

main().catch((err) => {
  logError("migrate-contacts", "Fatal", err);
  process.exit(1);
});
