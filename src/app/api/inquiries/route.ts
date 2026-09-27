import { createHash } from "node:crypto";
import { validateInquiry } from "@/lib/inquiries";

export const runtime = "nodejs";
export const maxDuration = 15;
const reply = (status: number, error?: string) =>
  Response.json(error ? { error } : { ok: true }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export async function POST(request: Request) {
  // Next.js may use an internal hostname in request.url behind its proxy.
  // Compare against the actual incoming Host and the proxy's protocol instead.
  const protocol = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.slice(0, -1);
  const expectedOrigin = `${protocol}://${request.headers.get("host")}`;
  if (request.headers.get("origin") !== expectedOrigin)
    return reply(403, "Invalid origin");
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return reply(415, "JSON required");
  if (Number(request.headers.get("content-length")) > 16384)
    return reply(413, "Request too large");
  let payload: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return reply(400, "Invalid body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        return reply(413, "Request too large");
      }
      chunks.push(value);
    }
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return reply(400, "Invalid JSON");
  }
  if (
    payload &&
    typeof payload === "object" &&
    "website" in payload &&
    payload.website
  )
    return reply(422, "Invalid submission");
  const inquiry = validateInquiry(payload);
  if (!inquiry) return reply(422, "Invalid inquiry");
  const endpoint = process.env.LEAD_WEBHOOK_URL;
  if (!endpoint) return reply(503, "Inquiries unavailable");
  try {
    if (new URL(endpoint).protocol !== "https:")
      return reply(503, "Inquiries unavailable");
  } catch {
    return reply(503, "Inquiries unavailable");
  }
  try {
    // Optional shared rate limit; use provider-side/WAF limits if Redis is not configured.
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (redisUrl && redisToken) {
      const identity = createHash("sha256").update(inquiry.email).digest("hex");
      const key = `mv:inquiry:${identity}:${Math.floor(Date.now() / 600000)}`;
      const limited = await fetch(`${redisUrl.replace(/\/$/, "")}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${redisToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          ["INCR", key],
          ["EXPIRE", key, 600],
        ]),
        signal: AbortSignal.timeout(2500),
        cache: "no-store",
        redirect: "error",
      });
      if (!limited.ok) return reply(503, "Inquiries unavailable");
      const counters: Array<{ result?: number; error?: string }> =
        await limited.json();
      if (
        counters.some((c) => c.error) ||
        typeof counters[0]?.result !== "number"
      )
        return reply(503, "Inquiries unavailable");
      if (counters[0].result > 5) return reply(429, "Please try again later");
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LEAD_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${process.env.LEAD_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        source: "maximus-vegas-landing",
        receivedAt: new Date().toISOString(),
        ...inquiry,
      }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return reply(502, "Delivery failed");
    return reply(200);
  } catch {
    return reply(503, "Inquiries unavailable");
  }
}
