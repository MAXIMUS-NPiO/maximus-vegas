/**
 * Third-party services actually connected to this deployment, derived from configuration at request time.
 * Used by the privacy notice so it names only real processors. Never exposes keys, credentials, database
 * names or full hostnames — only the provider, and a region where the provider publishes it in the host.
 */
import { databaseUrl } from "./db.ts";
import { mailTransport } from "./mail.ts";
import { paymentReadiness } from "./billing.ts";

export type ServiceLine = { kind: "hosting" | "database" | "email" | "payments" | "inquiries"; name: string; region: string | null; active: boolean };

const VERCEL_REGIONS: Record<string, string> = {
  iad1: "Washington, D.C., USA",
  cle1: "Cleveland, USA",
  pdx1: "Portland, USA",
  sfo1: "San Francisco, USA",
  fra1: "Frankfurt, Germany",
  cdg1: "Paris, France",
  lhr1: "London, United Kingdom",
  dub1: "Dublin, Ireland",
  arn1: "Stockholm, Sweden",
  bom1: "Mumbai, India",
  sin1: "Singapore",
  hnd1: "Tokyo, Japan",
  kix1: "Osaka, Japan",
  icn1: "Seoul, South Korea",
  syd1: "Sydney, Australia",
  gru1: "São Paulo, Brazil",
  cpt1: "Cape Town, South Africa",
  hkg1: "Hong Kong",
  dxb1: "Dubai, UAE",
};

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The registrable part of a hostname (e.g. api.resend.com → resend.com), so no internal host is shown. */
const domainOf = (host: string) => host.split(".").slice(-2).join(".");

function database(): ServiceLine {
  const host = hostOf(databaseUrl());
  if (!host) return { kind: "database", name: "PostgreSQL", region: null, active: false };
  const aws = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech$/.exec(host);
  if (host.endsWith(".neon.tech")) return { kind: "database", name: "Neon (PostgreSQL)", region: aws ? `AWS ${aws[1]}` : null, active: true };
  if (host.endsWith(".supabase.co") || host.endsWith(".supabase.com")) return { kind: "database", name: "Supabase (PostgreSQL)", region: null, active: true };
  if (host.includes("vercel-storage.com")) return { kind: "database", name: "Vercel Postgres", region: null, active: true };
  if (host.endsWith(".rds.amazonaws.com")) {
    const region = /\.([a-z]{2}-[a-z]+-\d)\.rds\.amazonaws\.com$/.exec(host);
    return { kind: "database", name: "Amazon RDS (PostgreSQL)", region: region ? `AWS ${region[1]}` : null, active: true };
  }
  if (/^(localhost|127\.0\.0\.1)$/.test(host)) return { kind: "database", name: "PostgreSQL", region: null, active: true };
  return { kind: "database", name: "PostgreSQL", region: null, active: true };
}

export function connectedServices(): ServiceLine[] {
  const lines: ServiceLine[] = [];
  const region = process.env.VERCEL_REGION?.trim() || null;
  lines.push({ kind: "hosting", name: process.env.VERCEL ? "Vercel" : "—", region: region ? (VERCEL_REGIONS[region] ?? region) : null, active: Boolean(process.env.VERCEL) });
  lines.push(database());
  const mail = mailTransport();
  if (mail && mail.name === "resend") lines.push({ kind: "email", name: "Resend", region: null, active: true });
  else if (mail && mail.name === "smtp") {
    const host = hostOf(process.env.SMTP_URL?.trim());
    lines.push({ kind: "email", name: host ? `SMTP (${domainOf(host)})` : "SMTP", region: null, active: true });
  } else lines.push({ kind: "email", name: "—", region: null, active: false });
  const pay = paymentReadiness();
  lines.push({ kind: "payments", name: pay.provider === "stripe" ? "Stripe" : "—", region: null, active: pay.ready });
  const lead = hostOf(process.env.LEAD_WEBHOOK_URL?.trim());
  if (lead) lines.push({ kind: "inquiries", name: domainOf(lead), region: null, active: true });
  return lines;
}
