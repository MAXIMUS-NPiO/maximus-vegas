/**
 * Durable email outbox. A message is first stored in `email_outbox` inside the caller's transaction, so a
 * saved account, application or invoice never depends on delivery. Delivery runs afterwards with retries
 * and backoff; `sent` means the mail service accepted the message, which is not proof of inbox delivery.
 *
 * Transports: Resend (RESEND_API_KEY) or any SMTP server (SMTP_URL), both with MAIL_FROM. Without them
 * messages stay queued and the interface says email is not connected — nothing is reported as sent.
 */
import type { Database, Queryable } from "./db.ts";
import { siteOrigin } from "../lib/site.ts";

export type Mail = { to: string; subject: string; text: string; html: string; idempotencyKey: string };
export type Transport = { name: string; send(mail: Mail): Promise<{ id: string }> };

type Holder = { __mvTestMail?: Mail[] };

/** In-memory transport for automated tests only (MAIL_TRANSPORT=test). */
export function testMailbox(): Mail[] {
  const holder = globalThis as Holder;
  holder.__mvTestMail ??= [];
  return holder.__mvTestMail;
}

function resend(from: string, key: string): Transport {
  return {
    name: "resend",
    async send(mail) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": mail.idempotencyKey },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !body.id) throw new Error(`resend ${res.status}: ${String(body.message ?? "rejected").slice(0, 200)}`);
      return { id: body.id };
    },
  };
}

function smtp(from: string, url: string): Transport {
  return {
    name: "smtp",
    async send(mail) {
      const { createTransport } = await import("nodemailer");
      const transport = createTransport(url);
      const info = await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, messageId: undefined });
      return { id: String(info.messageId ?? "") };
    },
  };
}

export function mailTransport(): Transport | null {
  if (process.env.MAIL_TRANSPORT === "test")
    return {
      name: "test",
      async send(mail) {
        if (process.env.MAIL_TEST_FAIL === "1") throw new Error("test transport failure");
        testMailbox().push(mail);
        return { id: `test-${testMailbox().length}` };
      },
    };
  const from = process.env.MAIL_FROM?.trim();
  if (!from || !siteOrigin()) return null;
  if (process.env.RESEND_API_KEY?.trim()) return resend(from, process.env.RESEND_API_KEY.trim());
  if (process.env.SMTP_URL?.trim()) return smtp(from, process.env.SMTP_URL.trim());
  return null;
}

export const mailConfigured = () => mailTransport() !== null;

/** Absolute link for emails. Always built from the configured origin, never from request headers. */
export function link(path: string): string {
  const origin = siteOrigin() ?? (process.env.MAIL_TRANSPORT === "test" ? "https://www.maximus.vegas" : "");
  return `${origin}${path}`;
}

export type Template =
  | "verify_email"
  | "reset_password"
  | "activate_account"
  | "account_exists"
  | "membership_application"
  | "membership_decision"
  | "invoice_issued"
  | "payment_received"
  | "membership_active";

export async function enqueueMail(
  q: Queryable,
  m: { to: string; template: Template; lang: "ru" | "en"; data: Record<string, unknown>; userId?: string | null; dedupeKey?: string },
) {
  await q.query(
    `insert into email_outbox (to_email, template, lang, data, user_id, dedupe_key) values ($1, $2, $3, $4, $5, $6)
     on conflict (dedupe_key) do nothing`,
    [m.to, m.template, m.lang, JSON.stringify(m.data), m.userId ?? null, m.dedupeKey ?? null],
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function render(template: Template, lang: "ru" | "en", data: Record<string, unknown>): { subject: string; lines: string[]; action?: { label: string; url: string } } {
  const ru = lang === "ru";
  const s = (x: unknown) => String(x ?? "");
  switch (template) {
    case "verify_email":
      return {
        subject: ru ? "Подтвердите email — MAXIMUS VEGAS" : "Confirm your email — MAXIMUS VEGAS",
        lines: [ru ? "Подтвердите адрес для аккаунта MAXIMUS VEGAS. Ссылка действует 48 часов и срабатывает один раз." : "Confirm this address for your MAXIMUS VEGAS account. The link works once and expires in 48 hours.", ru ? "Если вы не создавали аккаунт, просто проигнорируйте письмо." : "If you did not create an account, ignore this email."],
        action: { label: ru ? "Подтвердить email" : "Confirm email", url: s(data.url) },
      };
    case "activate_account":
      return {
        subject: ru ? "Завершите регистрацию — MAXIMUS VEGAS" : "Finish signing up — MAXIMUS VEGAS",
        lines: [ru ? "Чтобы активировать аккаунт, подтвердите email. Ссылка действует 24 часа и срабатывает один раз." : "Confirm your email to activate the account. The link works once and expires in 24 hours.", ru ? "Если вы не регистрировались, проигнорируйте письмо — аккаунт не будет создан." : "If you did not sign up, ignore this email — no account will be created."],
        action: { label: ru ? "Активировать аккаунт" : "Activate account", url: s(data.url) },
      };
    case "account_exists":
      return {
        subject: ru ? "Попытка регистрации — MAXIMUS VEGAS" : "Sign-up attempt — MAXIMUS VEGAS",
        lines: [ru ? "Кто-то пытался зарегистрироваться с этим адресом, но аккаунт уже существует." : "Someone tried to sign up with this address, but an account already exists.", ru ? "Если это были вы — войдите или восстановите пароль." : "If this was you, sign in or reset your password."],
        action: { label: ru ? "Восстановить пароль" : "Reset password", url: s(data.url) },
      };
    case "reset_password":
      return {
        subject: ru ? "Восстановление пароля — MAXIMUS VEGAS" : "Password reset — MAXIMUS VEGAS",
        lines: [ru ? "Ссылка для нового пароля действует 30 минут и срабатывает один раз. После смены пароля все сессии будут завершены." : "The link to set a new password works once and expires in 30 minutes. All sessions end after the change.", ru ? "Если вы не запрашивали восстановление, ничего не делайте." : "If you did not request this, do nothing."],
        action: { label: ru ? "Задать новый пароль" : "Set a new password", url: s(data.url) },
      };
    case "membership_application":
      return {
        subject: ru ? `Заявка ${s(data.reference)} получена` : `Application ${s(data.reference)} received`,
        lines: [ru ? `Заявка на членство сохранена под номером ${s(data.reference)}. Условия оплаты направляются только после рассмотрения.` : `Your membership application is saved as ${s(data.reference)}. Payment terms are issued only after review.`],
        action: { label: ru ? "Открыть статус" : "View status", url: s(data.url) },
      };
    case "membership_decision":
      return {
        subject: ru ? `Решение по заявке ${s(data.reference)}` : `Decision on application ${s(data.reference)}`,
        lines: [ru ? `Статус заявки ${s(data.reference)} изменён. Подробности — в разделе «Членство и счета».` : `The status of application ${s(data.reference)} has changed. Details are in Membership and billing.`],
        action: { label: ru ? "Открыть" : "Open", url: s(data.url) },
      };
    case "invoice_issued":
      return {
        subject: ru ? `Счёт ${s(data.number)} — MAXIMUS VEGAS` : `Invoice ${s(data.number)} — MAXIMUS VEGAS`,
        lines: [ru ? `Выставлен счёт ${s(data.number)} на ${s(data.amount)}. Получатель: ${s(data.recipient)}.` : `Invoice ${s(data.number)} for ${s(data.amount)} has been issued. Recipient: ${s(data.recipient)}.`],
        action: { label: ru ? "Открыть счёт" : "Open invoice", url: s(data.url) },
      };
    case "payment_received":
      return {
        subject: ru ? `Оплата по счёту ${s(data.number)} подтверждена` : `Payment for invoice ${s(data.number)} confirmed`,
        lines: [ru ? `Платёжный провайдер подтвердил оплату ${s(data.amount)} по счёту ${s(data.number)}.` : `The payment provider confirmed ${s(data.amount)} for invoice ${s(data.number)}.`],
        action: { label: ru ? "Квитанция" : "Receipt", url: s(data.url) },
      };
    case "membership_active":
      return {
        subject: ru ? "Членство активировано — MAXIMUS VEGAS" : "Membership activated — MAXIMUS VEGAS",
        lines: [ru ? `Членство действует до ${s(data.until)}.` : `Your membership is active until ${s(data.until)}.`],
        action: { label: ru ? "Открыть" : "Open", url: s(data.url) },
      };
  }
}

export function compose(template: Template, lang: "ru" | "en", data: Record<string, unknown>, to: string, key: string): Mail {
  const r = render(template, lang, data);
  const footer = lang === "ru" ? "MAXIMUS VEGAS L.L.C-FZ · Meydan Free Zone · Dubai, UAE" : "MAXIMUS VEGAS L.L.C-FZ · Meydan Free Zone · Dubai, UAE";
  const text = [...r.lines, ...(r.action ? ["", `${r.action.label}: ${r.action.url}`] : []), "", footer].join("\n");
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.5">
${r.lines.map((l) => `<p>${esc(l)}</p>`).join("\n")}
${r.action ? `<p><a href="${esc(r.action.url)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${esc(r.action.label)}</a></p><p style="font-size:12px;color:#555">${esc(r.action.url)}</p>` : ""}
<p style="font-size:12px;color:#555">${esc(footer)}</p></body></html>`;
  return { to, subject: r.subject, text, html, idempotencyKey: key };
}

const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 1440];
export const MAX_ATTEMPTS = 7;

/**
 * Delivers due messages. Claims rows with `for update skip locked`, so concurrent drains never send the
 * same message twice; a crashed claim is retried after its lock expires.
 */
export async function drainOutbox(db: Database, limit = 10): Promise<{ configured: boolean; sent: number; failed: number }> {
  const transport = mailTransport();
  if (!transport) return { configured: false, sent: 0, failed: 0 };
  const claimed = await db.query<{ id: string; to_email: string; template: Template; lang: "ru" | "en"; data: Record<string, unknown>; attempts: number; created_at: Date }>(
    `update email_outbox set status = 'sending', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
      where id in (select id from email_outbox
                    where ((status in ('pending','failed') and next_attempt_at <= now()) or (status = 'sending' and locked_until < now()))
                      and attempts < $2
                    order by created_at asc limit $1 for update skip locked)
      returning id, to_email, template, lang, data, attempts, created_at`,
    [limit, MAX_ATTEMPTS],
  );
  // RETURNING order is not guaranteed: deliver oldest first.
  const batch = claimed.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  let sent = 0;
  let failed = 0;
  for (const row of batch) {
    try {
      const mail = compose(row.template, row.lang, row.data, row.to_email, row.id);
      const result = await transport.send(mail);
      await db.query(
        "update email_outbox set status = 'sent', provider = $2, provider_message_id = $3, sent_at = now(), last_error = '', locked_until = null where id = $1",
        [row.id, transport.name, result.id],
      );
      sent++;
    } catch (error) {
      const wait = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)];
      await db.query(
        `update email_outbox set status = 'failed', last_error = $2, locked_until = null, provider = $3,
            next_attempt_at = now() + ($4 || ' minutes')::interval where id = $1`,
        [row.id, String((error as Error).message ?? error).slice(0, 300), transport.name, String(wait)],
      );
      failed++;
    }
  }
  return { configured: true, sent, failed };
}

export async function outboxSummary(q: Queryable) {
  const rows = await q.query<{ status: string; n: number }>("select status, count(*)::int as n from email_outbox group by status");
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
}
