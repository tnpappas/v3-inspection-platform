/**
 * Migration helpers — shared utilities used by all migration scripts.
 *
 * Follows the existing Replit project's patterns:
 *   - Drizzle ORM with node-postgres (Pool from "pg")
 *   - DATABASE_URL env var for connection
 *   - TypeScript strict mode
 *
 * ISN API access uses credentials from ~/.openclaw/secrets/isn.env.
 * PII-containing outputs go to migration/ (gitignored).
 */

import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Database connection
// ============================================================================

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Import schema lazily to avoid circular imports in migration scripts.
// Each script imports what it needs directly from the schema file.

// ============================================================================
// ISN API client (read-only)
// ============================================================================

const ISN_BASE = `https://${process.env.ISN_DOMAIN}/${process.env.ISN_COMPANY_KEY}/rest`;
const ISN_CREDENTIALS = Buffer.from(
  `${process.env.ISN_ACCESS_KEY}:${process.env.ISN_SECRET_ACCESS}`
).toString("base64");

export async function isnGet<T = unknown>(
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(`${ISN_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${ISN_CREDENTIALS}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`ISN API error ${res.status}: ${url}`);
  const json = await res.json() as { status: string; [key: string]: unknown };
  if (json.status !== "ok") throw new Error(`ISN error response: ${JSON.stringify(json)}`);
  return json as T;
}

/** Throttled ISN GET: waits 400ms between calls as specified in the migration plan. */
export async function isnGetThrottled<T = unknown>(
  pathStr: string,
  params?: Record<string, string>
): Promise<T> {
  await new Promise((r) => setTimeout(r, 400));
  return isnGet<T>(pathStr, params);
}

// ============================================================================
// Date/time helpers
// ============================================================================

/**
 * Parse any ISN datetime string to UTC.
 * - "2026-04-27 13:30:00" — no tz, treated as America/Los_Angeles (ISN is Pacific).
 * - "2026-04-26T19:46:06+00:00" — ISO 8601 with UTC offset.
 * Always returns timezone-aware UTC Date or null.
 */
export function parseIsnDatetime(s: string | null | undefined): Date | null {
  if (!s || s === "" || s === "No Date" || s === "No Time") return null;

  // ISO 8601 with offset
  if (s.includes("T") && (s.includes("+") || s.endsWith("Z"))) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  // Space-separated "YYYY-MM-DD HH:MM:SS" — treat as Pacific
  // Convert by appending a hardcoded Pacific offset. ISN uses Pacific Standard
  // Time (UTC-8) for most of year; Pacific Daylight Time (UTC-7) for DST.
  // The safest approach: treat as US/Pacific and let the JS Date parse it.
  // Node 18+ supports Intl.DateTimeFormat which we use here.
  const cleaned = s.trim().replace(" ", "T");
  const asPacific = new Date(`${cleaned}-08:00`); // assume PST for simplicity
  return isNaN(asPacific.getTime()) ? null : asPacific;
}

// ============================================================================
// Boolean coercion
// ============================================================================

/**
 * Coerce ISN's stringly-typed booleans to JS boolean.
 * ISN uses "yes"/"no"/"Yes"/"No"/"true"/"false" inconsistently.
 */
export function coerceIsnBoolean(
  s: string | boolean | null | undefined
): boolean {
  if (typeof s === "boolean") return s;
  if (!s) return false;
  return s.toLowerCase() === "yes" || s.toLowerCase() === "true";
}

// ============================================================================
// String normalization
// ============================================================================

/** Trim leading/trailing whitespace. ISN has inconsistent whitespace on many fields. */
export function normalizeIsnString(
  s: string | null | undefined
): string | null {
  if (s === null || s === undefined) return null;
  const t = s.trim();
  return t === "" ? null : t;
}

// ============================================================================
// Status derivation
// ============================================================================

export type InspectionStatus =
  | "scheduled"
  | "confirmed"
  | "en_route"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show"
  | "on_hold";

export type PaymentStatus = "unpaid" | "partial" | "paid" | "refunded" | "disputed";
export type SignatureStatus = "unsigned" | "signed" | "expired";
export type BookingSource =
  | "dispatcher"
  | "realtor_portal"
  | "client_booking"
  | "phone"
  | "email"
  | "api";

export interface ISNOrderDetail {
  id: string;
  oid?: number | string;
  deleteddatetime?: string | null;
  complete?: string;
  confirmeddatetime?: string | null;
  scheduleddatetime?: string | null;
  datetime?: string | null;
  paid?: string;
  signature?: string;
  osorder?: string;
  osscheduleddatetime?: string | null;
  show?: string;
  [key: string]: unknown;
}

export function deriveStatusFromIsnOrder(order: ISNOrderDetail): InspectionStatus {
  if (order.deleteddatetime) return "cancelled";
  if (order.complete === "yes") return "completed";
  if (order.confirmeddatetime) return "confirmed";
  if (order.datetime && order.datetime !== "No Date") return "scheduled";
  return "on_hold";
}

export function derivePaymentStatusFromIsn(order: ISNOrderDetail): PaymentStatus {
  return coerceIsnBoolean(order.paid as string) ? "paid" : "unpaid";
}

export function deriveSignatureStatusFromIsn(order: ISNOrderDetail): SignatureStatus {
  return coerceIsnBoolean(order.signature as string) ? "signed" : "unsigned";
}

/**
 * Map ISN's osorder flag to booking source.
 * "yes" → realtor_portal (Online Scheduler feature, per spec 04 resolution).
 * "no"  → dispatcher.
 * Account-agnostic: licensees with different volume mixes use the same logic.
 */
export function deriveSourceFromIsnOrder(order: ISNOrderDetail): BookingSource {
  return coerceIsnBoolean(order.osorder as string) ? "realtor_portal" : "dispatcher";
}

// ============================================================================
// ON_HOLD sentinel
// ============================================================================

/** UTC sentinel for on_hold inspections with no locked date. */
export const ON_HOLD_PLACEHOLDER_AT = new Date("9999-12-31T23:59:59.000Z");

// ============================================================================
// Custom fields / controls split
// ============================================================================

export interface ISNControl {
  name?: string;
  label?: string;
  value?: string | null;
  [key: string]: unknown;
}

interface ParseControlsResult {
  customFields: Record<string, unknown>;
  scriptsDropped: Array<{ name: string; reason: string }>;
}

/** Known call-center script patterns to drop. */
const SCRIPT_PATTERNS = [
  /^<\s*you\s*>/i,
  /^<\s*them\s*>/i,
  /^\*{2,}/,
  /phonetically/i,
  /spell\s+back/i,
  /say\s+to\s+client/i,
  /^-{3,}/,             // separator rows
];

/** Known section header names that are not data fields. */
const SECTION_HEADERS = new Set([
  "Client Infomation",
  "Client Information",
  "Escrow Fields",
  "Termite Inspections",
]);

export function parseIsnControls(controls: ISNControl[]): ParseControlsResult {
  const customFields: Record<string, unknown> = {};
  const scriptsDropped: Array<{ name: string; reason: string }> = [];

  for (const ctrl of controls) {
    const name = (ctrl.name || ctrl.label || "").trim();
    if (!name) continue;

    // Skip empty values
    if (ctrl.value === null || ctrl.value === undefined || ctrl.value === "") continue;
    if (["---", "n/a", "N/A"].includes(ctrl.value as string)) continue;

    // Check if script
    if (SECTION_HEADERS.has(name)) {
      scriptsDropped.push({ name, reason: "section header" });
      continue;
    }
    const isScript = SCRIPT_PATTERNS.some((p) => p.test(name));
    if (isScript) {
      scriptsDropped.push({ name, reason: "call-center script pattern" });
      continue;
    }

    // Sanitize key: lowercase, replace spaces with underscores, remove non-alnum
    const key = name
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
    if (key) customFields[key] = ctrl.value;
  }

  return { customFields, scriptsDropped };
}

// ============================================================================
// Deduplication keys
// ============================================================================

export function propertyDedupeKey(p: {
  address1: string;
  city: string;
  state: string;
  zip: string;
}): string {
  return [p.address1, p.city, p.state, p.zip]
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
}

export function customerDedupeKey(c: {
  email: string | null;
  displayName: string;
}): string {
  return [
    (c.email || "").trim().toLowerCase(),
    c.displayName.trim().toLowerCase(),
  ].join("|");
}

// ============================================================================
// ISN history event hash (for audit_log dedup via requestId)
// ============================================================================

export function isnEventHash(isnOrderId: string, eventWhen: string): string {
  return createHash("sha256")
    .update(`${isnOrderId}|${eventWhen}`)
    .digest("hex")
    .slice(0, 36); // fits in uuid-like column length
}

// ============================================================================
// Per-account migration config
// ============================================================================

export type Role =
  | "owner"
  | "operations_manager"
  | "dispatcher"
  | "technician"
  | "client_success"
  | "bookkeeper"
  | "viewer";

export type AccountRoleMapping = Partial<
  Record<
    "inspector" | "owner" | "manager" | "officestaff" | "callcenter" | "thirdparty",
    Role | null
  >
>;

export interface PerAccountConfig {
  accountSlug: string;
  roleMapping?: AccountRoleMapping;
  /** Overrides per-business-type duration defaults. */
  durationOverrides?: Partial<Record<"inspection" | "pool" | "pest" | "other", number>>;
}

export const DEFAULT_ROLE_MAPPING: Required<AccountRoleMapping> = {
  inspector: "technician",
  owner: "owner",
  manager: "operations_manager",
  officestaff: "dispatcher",
  callcenter: "client_success",
  thirdparty: "viewer",
};

export const DURATION_DEFAULTS: Record<"inspection" | "pool" | "pest" | "other", number> = {
  inspection: 180,
  pool: 60,
  pest: 45,
  other: 60,
};

export function defaultDurationForBusinessType(
  type: string,
  config?: PerAccountConfig
): number {
  const override = config?.durationOverrides?.[type as keyof typeof DURATION_DEFAULTS];
  if (override) return override;
  return DURATION_DEFAULTS[type as keyof typeof DURATION_DEFAULTS] ?? 60;
}

// ============================================================================
// CSV writer for PII-containing audit outputs
// ============================================================================

export function writeCsvLine(
  filePath: string,
  record: Record<string, string | null | undefined>
): void {
  const line =
    Object.values(record)
      .map((v) => {
        const str = v === null || v === undefined ? "" : String(v);
        return `"${str.replace(/"/g, '""')}"`;
      })
      .join(",") + "\n";
  fs.appendFileSync(filePath, line, "utf8");
}

export function writeCsvHeader(
  filePath: string,
  headers: string[]
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    filePath,
    headers.map((h) => `"${h}"`).join(",") + "\n",
    "utf8"
  );
}

// ============================================================================
// Logger
// ============================================================================

export function log(step: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${step}] ${message}`);
}

export function logError(step: string, message: string, err?: unknown): void {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [${step}] ERROR: ${message}`, err ?? "");
}
