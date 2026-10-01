/**
 * MV-STAFF-1 messages from the portal team to a segment of accounts, delivered in the portal: a
 * notification that opens the message's own page.
 *
 * Operational messages concern the service the account uses (rules, maintenance, safety) and reach the
 * whole segment. Marketing messages reach only accounts with marketing consent at the moment of sending,
 * and at most MARKETING_CAP marketing messages per account in any CAP_DAYS days. Every account of the
 * segment gets a recorded status (sent, skipped_consent, skipped_cap) and the first opening is recorded:
 * these are the delivery statuses and the metrics. A template is reusable text that is never sent itself.
 * Email is not used for these messages.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { requireSection } from "./access.ts";
import { canSendMessage } from "./staff-roles.ts";
import { requireStepUp } from "./mfa.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";
import { isGame } from "../lib/games.ts";
import { isCountry } from "../lib/countries.ts";

export const MARKETING_CAP = 2;
export const CAP_DAYS = 7;
export const MESSAGE_KINDS = ["operational", "marketing"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const AUDIENCES = ["all", "players", "organizers"] as const;
export type Audience = (typeof AUDIENCES)[number];
export const ACTIVE_DAYS = [7, 30, 90] as const;
/** Sends are serialised, so two marketing messages sent at once cannot both pass the frequency cap. */
const MESSAGE_LOCK = 7461004;

export type Segment = {
  audience: Audience;
  game: string;
  country: string;
  activeDays: number;
};
export type DeliveryStats = {
  sent?: number;
  skipped_consent?: number;
  skipped_cap?: number;
};
export type StaffMessage = {
  id: string;
  kind: MessageKind;
  title: string;
  body: string;
  segment: Segment;
  status: "draft" | "template" | "sent";
  stats: DeliveryStats;
  author: string;
  created_at: Date;
  sender: string | null;
  sent_at: Date | null;
  opened: number;
};

type Input = Record<string, unknown>;

export function parseSegment(input: Input): Segment {
  const audience = (AUDIENCES as readonly string[]).includes(String(input.audience)) ? (String(input.audience) as Audience) : "all";
  const game = input.game ? (isGame(input.game) ? String(input.game) : fail("invalid_game")) : "";
  const country = input.country ? (isCountry(input.country) ? String(input.country) : fail("invalid_input")) : "";
  const days = Number(input.activeDays);
  const activeDays = (ACTIVE_DAYS as readonly number[]).includes(days) ? days : 0;
  return { audience, game, country, activeDays };
}

/** Accounts of a segment: active accounts only (never suspended, deleted or unconfirmed ones). */
function segmentWhere(s: Segment, params: unknown[]): string {
  const where = ["u.status = 'active'"];
  if (s.audience === "players")
    where.push(`(exists (select 1 from roster_entries r where r.user_id = u.id)
              or exists (select 1 from linked_game_accounts g where g.user_id = u.id)
              or exists (select 1 from ratings x where x.user_id = u.id))`);
  if (s.audience === "organizers") where.push("exists (select 1 from org_members o where o.user_id = u.id)");
  if (s.game) {
    params.push(s.game);
    const p = `$${params.length}`;
    where.push(`(exists (select 1 from linked_game_accounts g where g.user_id = u.id and g.game = ${p})
              or exists (select 1 from ratings x where x.user_id = u.id and x.game = ${p})
              or exists (select 1 from roster_entries r join tournaments t on t.id = r.tournament_id where r.user_id = u.id and t.game = ${p}))`);
  }
  if (s.country) {
    params.push(s.country);
    where.push(`u.country_code = $${params.length}`);
  }
  if (s.activeDays) {
    params.push(s.activeDays);
    where.push(`exists (select 1 from sessions x where x.user_id = u.id and x.last_seen_at > now() - make_interval(days => $${params.length}::int))`);
  }
  return where.join(" and ");
}

/** Marketing messages an account received in the cap window (an expression over `u`). */
const RECENT_MARKETING = `(select count(*) from message_recipients mr join staff_messages sm on sm.id = mr.message_id
                            where mr.user_id = u.id and mr.status = 'sent' and sm.kind = 'marketing'
                              and mr.created_at > now() - make_interval(days => ${CAP_DAYS}))`;

const kindOf = (value: unknown): MessageKind =>
  (MESSAGE_KINDS as readonly string[]).includes(String(value)) ? (String(value) as MessageKind) : fail("message_kind");

/** The messages section, and the right to write this kind: marketing for the marketing role, operational for support or infrastructure. */
function guard(user: SessionUser, kind: MessageKind) {
  requireSection(user, "messages");
  if (!canSendMessage(user.roles, kind)) fail("message_kind");
}

function content(input: Input) {
  const title = v.oneLine(input.title, 120);
  const body = v.clean(input.body, 2000);
  if (title.length < 3 || !body) fail("invalid_input");
  return { title, body };
}

export async function createMessage(db: Database, user: SessionUser, input: Input): Promise<{ id: string }> {
  const kind = kindOf(input.kind);
  guard(user, kind);
  const { title, body } = content(input);
  const segment = parseSegment(input);
  const status = input.template === "1" ? "template" : "draft";
  return db.tx(async (q) => {
    const [row] = await q.query<{ id: string }>(
      "insert into staff_messages (kind, title, body, segment, status, created_by) values ($1, $2, $3, $4, $5, $6) returning id",
      [kind, title, body, JSON.stringify(segment), status, user.id],
    );
    await audit(q, {
      actorId: user.id,
      action: "message.created",
      entity: "staff_message",
      entityId: row.id,
      data: { kind, status },
    });
    return row;
  });
}

async function lockEditable(q: Queryable, id: string) {
  const [row] = await q.query<{
    id: string;
    kind: MessageKind;
    title: string;
    body: string;
    segment: Segment;
    status: string;
  }>("select id, kind, title, body, segment, status from staff_messages where id = $1 for update", [id]);
  if (!row) fail("not_found");
  return row!;
}

/** Drafts and templates change; a sent message is a record and stays as sent. */
export async function updateMessage(db: Database, user: SessionUser, id: string, input: Input) {
  const kind = kindOf(input.kind);
  guard(user, kind);
  const { title, body } = content(input);
  const segment = parseSegment(input);
  await db.tx(async (q) => {
    const row = await lockEditable(q, id);
    guard(user, row.kind);
    if (row.status === "sent") fail("message_state");
    await q.query("update staff_messages set kind = $2, title = $3, body = $4, segment = $5 where id = $1", [id, kind, title, body, JSON.stringify(segment)]);
    await audit(q, {
      actorId: user.id,
      action: "message.updated",
      entity: "staff_message",
      entityId: id,
      data: { kind },
    });
  });
}

/** A new draft (or template) from any message: how templates are used and how a message is sent to another segment. */
export async function copyMessage(db: Database, user: SessionUser, id: string, as: unknown): Promise<{ id: string }> {
  const status = as === "template" ? "template" : "draft";
  return db.tx(async (q) => {
    const [src] = await q.query<{ kind: MessageKind }>("select kind from staff_messages where id = $1", [id]);
    if (!src) fail("not_found");
    guard(user, src.kind);
    const [row] = await q.query<{ id: string }>(
      `insert into staff_messages (kind, title, body, segment, status, created_by)
       select kind, title, body, segment, $2, $3 from staff_messages where id = $1 returning id`,
      [id, status, user.id],
    );
    await audit(q, {
      actorId: user.id,
      action: "message.copied",
      entity: "staff_message",
      entityId: row.id,
      data: { from: id, status },
    });
    return row;
  });
}

export async function deleteMessage(db: Database, user: SessionUser, id: string) {
  await db.tx(async (q) => {
    const row = await lockEditable(q, id);
    guard(user, row.kind);
    if (row.status === "sent") fail("message_state");
    await q.query("delete from staff_messages where id = $1", [id]);
    await audit(q, {
      actorId: user.id,
      action: "message.deleted",
      entity: "staff_message",
      entityId: id,
      data: { kind: row.kind, title: row.title },
    });
  });
}

/** How many accounts a message would reach now, before it is sent. */
export async function previewReach(q: Queryable, kind: MessageKind, segment: Segment) {
  const params: unknown[] = [];
  const where = segmentWhere(segment, params);
  const [row] = await q.query<{
    total: number;
    consent: number;
    capped: number;
  }>(
    `select count(*)::int as total,
            count(*) filter (where u.marketing_opt_in_at is not null)::int as consent,
            count(*) filter (where u.marketing_opt_in_at is not null and ${RECENT_MARKETING} >= ${MARKETING_CAP})::int as capped
       from users u where ${where}`,
    params,
  );
  const total = row?.total ?? 0;
  if (kind === "operational") return { total, reach: total, skippedConsent: 0, skippedCap: 0 };
  const consent = row?.consent ?? 0;
  const capped = row?.capped ?? 0;
  return {
    total,
    reach: consent - capped,
    skippedConsent: total - consent,
    skippedCap: capped,
  };
}

/**
 * Sends a draft once: every account of the segment gets its status in one statement, the sent ones a
 * notification. Requires a second factor confirmed in the last minutes (it reaches many people).
 */
export async function sendMessage(db: Database, user: SessionUser, id: string): Promise<DeliveryStats> {
  requireSection(user, "messages");
  requireStepUp(user);
  return db.tx(async (q) => {
    const row = await lockEditable(q, id);
    guard(user, row.kind);
    if (row.status !== "draft") fail("message_state");
    await q.query("select pg_advisory_xact_lock($1)", [MESSAGE_LOCK]);
    const params: unknown[] = [id, row.kind, MARKETING_CAP];
    const where = segmentWhere(parseSegment(row.segment), params);
    await q.query(
      `insert into message_recipients (message_id, user_id, status)
       select $1::uuid, u.id,
              case when $2::text = 'operational' then 'sent'
                   when u.marketing_opt_in_at is null then 'skipped_consent'
                   when ${RECENT_MARKETING} >= $3::int then 'skipped_cap'
                   else 'sent' end
         from users u where ${where}`,
      params,
    );
    const counts = await q.query<{ status: keyof DeliveryStats; n: number }>(
      "select status, count(*)::int as n from message_recipients where message_id = $1 group by status",
      [id],
    );
    if (!counts.length) fail("message_empty");
    const stats: DeliveryStats = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    await q.query(
      `insert into notifications (user_id, kind, data)
       select user_id, 'staff_message', jsonb_build_object('title', $2::text, 'messageId', message_id::text)
         from message_recipients where message_id = $1::uuid and status = 'sent'`,
      [id, row.title],
    );
    await q.query("update staff_messages set status = 'sent', stats = $2, sent_by = $3, sent_at = now() where id = $1", [id, JSON.stringify(stats), user.id]);
    await audit(q, {
      actorId: user.id,
      action: "message.sent",
      entity: "staff_message",
      entityId: id,
      data: { kind: row.kind, segment: row.segment, stats },
    });
    return stats;
  });
}

export async function messageList(q: Queryable, limit = 50) {
  return q.query<StaffMessage>(
    `select m.id, m.kind, m.title, m.body, m.segment, m.status, m.stats, a.username as author, m.created_at,
            s.username as sender, m.sent_at,
            (select count(*) from message_recipients r where r.message_id = m.id and r.opened_at is not null)::int as opened
       from staff_messages m join users a on a.id = m.created_by left join users s on s.id = m.sent_by
      order by (m.status = 'sent'), coalesce(m.sent_at, m.created_at) desc limit $1`,
    [limit],
  );
}

/** The message as its recipient sees it; the first opening is recorded and its notification marked read. */
export async function openMessage(db: Database, userId: string, id: string) {
  const [m] = await db.query<{
    id: string;
    kind: MessageKind;
    title: string;
    body: string;
    sent_at: Date;
    opened_at: Date | null;
  }>(
    `select m.id, m.kind, m.title, m.body, m.sent_at, r.opened_at
       from staff_messages m join message_recipients r on r.message_id = m.id
      where m.id = $1 and r.user_id = $2 and r.status = 'sent'`,
    [id, userId],
  );
  if (!m) return null;
  if (!m.opened_at) {
    await db.query("update message_recipients set opened_at = now() where message_id = $1 and user_id = $2 and opened_at is null", [id, userId]);
    await db.query("update notifications set read_at = now() where user_id = $1 and kind = 'staff_message' and data->>'messageId' = $2 and read_at is null", [
      userId,
      id,
    ]);
  }
  return m;
}

/** Account export: the portal team's messages addressed to the account, with their delivery status. */
export async function messageExport(q: Queryable, userId: string) {
  return q.query(
    `select m.kind, m.title, r.status, r.created_at, r.opened_at
       from message_recipients r join staff_messages m on m.id = r.message_id where r.user_id = $1 order by r.created_at`,
    [userId],
  );
}

/** Account deletion: delivery records of the account go; each message keeps only its totals. */
export async function eraseMessageData(q: Queryable, userId: string) {
  await q.query("delete from message_recipients where user_id = $1", [userId]);
}
