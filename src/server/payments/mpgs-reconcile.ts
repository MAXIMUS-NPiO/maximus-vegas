import type { Database } from "../db.ts";
import { applySessionState, paymentProvider } from "../billing.ts";
import { reconcileBroadcastPayment } from "../broadcast-payments.ts";

/** Bounded, rotating order reconciliation. Reads capture/refund/dispute state from MPGS only. */
export async function reconcileMpgsPayments(db: Database) {
  const p = paymentProvider();
  if (p?.name !== "mpgs") return { checked: 0, failed: 0 };
  const due = await db.query<{ id: string; request: { attemptId: string; metadata: Record<string, string> } }>(
    `select id,request from mpgs_sessions where mode=$1 and creation_started=true
     and created_at > now()-interval '400 days'
     and (checked_at is null or checked_at < now()-interval '5 minutes')
     order by checked_at nulls first,created_at limit 20`, [p.mode]);
  let failed = 0, checked = 0;
  const deadline = Date.now() + 40_000;
  for (const row of due) {
    if (Date.now() >= deadline) break;
    try {
      const state = await p.retrieveSession(row.id);
      if (row.request.metadata.product === "native_broadcast") {
        await reconcileBroadcastPayment(db, row.request.attemptId, state, p);
      } else {
        const [a] = await db.query<Parameters<typeof applySessionState>[1]>("select * from payment_attempts where id=$1 and provider='mpgs'", [row.request.attemptId]);
        if (a && a.mode === p.mode) {
          if (!a.provider_session_id) {
            await db.query("update payment_attempts set provider_session_id=$2 where id=$1 and provider_session_id is null", [a.id, row.id]);
            a.provider_session_id = row.id;
          }
          await applySessionState(db, a, state, "sweep");
        }
      }
      checked++;
    } catch { failed++; }
    // Rotate even a temporarily failing order, so it cannot starve the queue.
    await db.query("update mpgs_sessions set checked_at=now() where id=$1", [row.id]);
  }
  return { checked, failed };
}
