import { getDb } from "@/server/db.ts";
import { paymentReadiness, paymentProvider, RECIPIENT } from "@/server/billing.ts";
import { mpgsLaunch } from "@/server/payments/mpgs.ts";
import { mpgsCheckoutPage } from "@/server/payments/mpgs-page.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const noStore = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
  if (process.env.PAYMENT_PROVIDER !== "mpgs" || !paymentReadiness().ready) return new Response("Payment unavailable", { status: 503, headers: noStore });
  try {
    const url = new URL(request.url);
    const launch = await mpgsLaunch(await getDb(), url.searchParams.get("order") ?? "", url.searchParams.get("token") ?? "");
    if (!launch) return new Response("Checkout not found or expired", { status: 404, headers: noStore });
    const state = await paymentProvider()!.retrieveSession(launch.row.id);
    if (state.status !== "open" || !state.url) return new Response(null, { status: 303, headers: { ...noStore, Location: launch.row.request.successUrl } });
    const page = mpgsCheckoutPage({ gateway: launch.config.gateway, session: launch.row.session_id!, merchant: launch.config.merchantName,
      beneficiary: process.env.MPGS_BENEFICIARY_LEGAL_NAME ?? RECIPIENT, amount: launch.row.request.amountMinor,
      lang: launch.row.request.locale, cancel: launch.row.request.cancelUrl });
    return new Response(page.body, { headers: page.headers });
  } catch { return new Response("Payment unavailable; check the invoice before retrying", { status: 503, headers: noStore }); }
}
