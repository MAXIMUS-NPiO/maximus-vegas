import { CURRENCIES, exponentOf, paymentReadiness, RECIPIENT } from "./billing.ts";
import type { Queryable } from "./db.ts";
import { fail } from "./errors.ts";
import { featureEnabled, maintenanceState } from "./system.ts";

export type BroadcastMode = "live" | "record" | "live_record";
export type BroadcastTariff = {
  version: string; approvalRef: string; currency: string; exponent: number;
  minuteMinor: number; storageMinuteDayMinor: number; maxViewers: number; maxDays: number;
  terms: { ru: string; en: string }; refunds: { ru: string; en: string }; tax: { ru: string; en: string };
};
const integer = (n: unknown, low: number, high: number) => Number.isSafeInteger(n) && Number(n) >= low && Number(n) <= high;
const words = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const bilingual = (v: unknown): v is { ru: string; en: string } => !!v && typeof v === "object" && words((v as Record<string, unknown>).ru, 8000) && words((v as Record<string, unknown>).en, 8000);

/** No sale prices or legal terms are invented. A complete approved configuration is required. */
export function broadcastTariff(): BroadcastTariff | null {
  try {
    const t = JSON.parse(process.env.MV_BROADCAST_TARIFF ?? "null");
    if (!t || !words(t.version, 80) || !words(t.approvalRef, 200) || !CURRENCIES.includes(t.currency) ||
      !integer(t.minuteMinor, 1, 100000) || !integer(t.storageMinuteDayMinor, 1, 10000) ||
      !integer(t.maxViewers, 1, 100) || !integer(t.maxDays, 1, 3650) || !bilingual(t.terms) || !bilingual(t.refunds) || !bilingual(t.tax)) return null;
    return { version: t.version, approvalRef: t.approvalRef, currency: t.currency, exponent: exponentOf(t.currency),
      minuteMinor: t.minuteMinor, storageMinuteDayMinor: t.storageMinuteDayMinor, maxViewers: t.maxViewers, maxDays: t.maxDays,
      terms: t.terms, refunds: t.refunds, tax: t.tax };
  } catch { return null; }
}

export function broadcastConfig() {
  const url = process.env.LIVEKIT_URL ?? "";
  let validUrl = false;
  try { const u = new URL(url); validUrl = u.protocol === "wss:" && u.hostname.endsWith(".livekit.cloud") && !u.port && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash; } catch { /* missing configuration */ }
  const ready = validUrl && !!process.env.LIVEKIT_API_KEY && !!process.env.LIVEKIT_API_SECRET &&
    !!process.env.BROADCAST_S3_BUCKET && !!process.env.BROADCAST_S3_REGION &&
    !!process.env.BROADCAST_S3_ACCESS_KEY_ID && !!process.env.BROADCAST_S3_SECRET_ACCESS_KEY &&
    process.env.BROADCAST_PRIVATE_STORAGE_CONFIRMED === "1";
  return { ready, url, apiKey: process.env.LIVEKIT_API_KEY ?? "", apiSecret: process.env.LIVEKIT_API_SECRET ?? "",
    bucket: process.env.BROADCAST_S3_BUCKET ?? "", region: process.env.BROADCAST_S3_REGION ?? "",
    accessKey: process.env.BROADCAST_S3_ACCESS_KEY_ID ?? "", secret: process.env.BROADCAST_S3_SECRET_ACCESS_KEY ?? "" };
}

export async function broadcastAvailability(db: Queryable) {
  const tariff = broadcastTariff();
  const [run] = await db.query<{ last_at: Date; result: { healthy?: boolean } }>("select last_at,result from system_runs where name='broadcasts'");
  const scheduler = !!run && run.result.healthy === true && Date.now() - new Date(run.last_at).getTime() < 150000;
  const ready = process.env.MV_BROADCAST_ENABLED === "1" && broadcastConfig().ready && scheduler &&
    !!tariff && paymentReadiness().ready && (process.env.MERCHANT_LEGAL_NAME === RECIPIENT || !!paymentReadiness().collector) &&
    (paymentReadiness().provider !== "mpgs" || tariff.currency === "AED") &&
    (process.env.VERCEL_ENV !== "production" || paymentReadiness().mode === "live") &&
    await featureEnabled(db, "broadcasting") && !(await maintenanceState(db)).on;
  return { ready, tariff, paymentMode: paymentReadiness().mode };
}

export function broadcastQuote(input: Record<string, unknown>, tariff: BroadcastTariff) {
  const mode = input.mode;
  if (mode !== "live" && mode !== "record" && mode !== "live_record") return fail("invalid_input");
  const minutes = Number(input.minutes), retentionDays = mode === "live" ? 0 : Number(input.retentionDays);
  if (!integer(minutes, 5, 480) || !integer(retentionDays, mode === "live" ? 0 : 1, tariff.maxDays)) fail("invalid_input");
  const amountMinor = minutes * tariff.minuteMinor + minutes * retentionDays * tariff.storageMinuteDayMinor;
  if (!integer(amountMinor, 1, 99999999)) fail("invalid_input");
  return { mode, minutes, retentionDays, maxViewers: mode === "record" ? 0 : tariff.maxViewers, amountMinor,
    currency: tariff.currency, exponent: tariff.exponent, version: tariff.version };
}
