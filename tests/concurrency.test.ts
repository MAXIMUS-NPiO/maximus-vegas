import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition } from "../src/server/tournaments.ts";
import { confirmResult, submitResult } from "../src/server/matches.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { recordGame } from "../src/server/lobbies.ts";

// Runs against a real multi-connection PostgreSQL: PG_TEST_URL=postgres://… npm test
const url = process.env.PG_TEST_URL;

test("concurrent registrations, confirmations and audit writes stay consistent", { skip: !url }, async () => {
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    return (await sessionUser(db, s.token))!;
  };
  const org = await mk("co");
  const space = await createOrg(db, org, { name: `Conc ${run}`, description: "" });
  const t = await createTournament(db, org, space.id, {
    name: `Conc Cup ${run}`, game: "cs2", participantType: "solo", teamSize: 1, maxParticipants: 8,
    checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC", description: "", rules: "",
  });
  await transition(db, org, t.id, "PUBLISHED");
  await transition(db, org, t.id, "REGISTRATION_OPEN");
  const players = await Promise.all(Array.from({ length: 12 }, (_, i) => mk(`cp${i}`)));
  // 12 players race for 8 slots, each also double-submits.
  const results = await Promise.allSettled(players.flatMap((p) => [register(db, p, t.id), register(db, p, t.id)]));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ status: string }>).value);
  assert.equal(ok.length, 12, "exactly one entry per player");
  assert.equal(ok.filter((r) => r.status === "registered").length, 8, "capacity respected under contention");
  assert.equal(ok.filter((r) => r.status === "waitlisted").length, 4);
  await transition(db, org, t.id, "REGISTRATION_CLOSED");
  await transition(db, org, t.id, "IN_PROGRESS");
  const [m] = await db.query<{ id: string; a_reg: string; b_reg: string }>(
    "select id, a_reg, b_reg from matches where tournament_id = $1 and round = 1 order by position limit 1",
    [t.id],
  );
  const leader = async (reg: string) => {
    const [r] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [reg]);
    return players.find((p) => p.id === r.user_id)!;
  };
  const a = await leader(m.a_reg);
  const b = await leader(m.b_reg);
  await submitResult(db, a, m.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  // Ten simultaneous confirmations: one wins, the winner advances exactly once.
  const confirms = await Promise.allSettled(Array.from({ length: 10 }, () => confirmResult(db, b, m.id)));
  assert.equal(confirms.filter((r) => r.status === "fulfilled").length, 1);
  const [next] = await db.query<{ a_reg: string | null; b_reg: string | null }>(
    "select n.a_reg, n.b_reg from matches m join matches n on n.id = m.next_match_id where m.id = $1",
    [m.id],
  );
  assert.equal([next.a_reg, next.b_reg].filter((x) => x === m.a_reg).length, 1);
  const [versions] = await db.query<{ n: number }>("select count(*)::int as n from match_results where match_id = $1 and status = 'confirmed'", [m.id]);
  assert.equal(versions.n, 1);
  const chain = await verifyAuditChain(db);
  assert.equal(chain.valid, true, "audit chain intact after concurrent writes");
  await db.close();
});

// ---- Release 2: payments, coins, quick match and double elimination under real concurrency ----
import { createHmac } from "node:crypto";
import {
  applyForMembership,
  approveOffer,
  createOfferVersion,
  decideApplication,
  handleProviderWebhook,
  issueInvoice,
  setPaymentProviderForTests,
  startCheckout,
} from "../src/server/billing.ts";
import { claimObjective, moveCoins, balance } from "../src/server/progression.ts";
import { answerReadyCheck, createParty, inviteToParty, joinQuickMatch, respondPartyInvite } from "../src/server/quickmatch.ts";
import { officialResult } from "../src/server/matches.ts";
import { WebhookSignatureError, type PaymentProvider, type SessionState } from "../src/server/payments/provider.ts";

test("payments, coins, quick match and bracket decisions stay consistent under parallel requests", { skip: !url }, async () => {
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string, verified = true): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    if (verified) await db.query("update users set email_verified_at = now() where id = (select user_id from sessions where id = encode(sha256($1::bytea), 'hex'))", [s.token]);
    return (await sessionUser(db, s.token))!;
  };
  // Mock provider (no network): records sessions, verifies an HMAC signature.
  const secret = "mock_secret";
  const sessions = new Map<string, SessionState>();
  let created = 0;
  const provider: PaymentProvider = {
    name: "mock",
    mode: "test",
    checkoutHosts: ["checkout.mock.test"],
    async createCheckout(req) {
      const id = `cs_${run}_${req.idempotencyKey}`;
      if (!sessions.has(id)) {
        created++;
        sessions.set(id, { id, url: `https://checkout.mock.test/${id}`, status: "open", paymentStatus: "unpaid", amountTotal: req.amountMinor, currency: req.currency, paymentIntentId: null, clientReferenceId: req.invoiceId, metadata: req.metadata, livemode: false });
      }
      return { id, url: `https://checkout.mock.test/${id}`, expiresAt: req.expiresAt };
    },
    async retrieveSession(id) {
      return sessions.get(id)!;
    },
    async retrievePaymentIntent(id) {
      return { id, metadata: {}, amount: 0, currency: "AED", status: "succeeded", livemode: false };
    },
    verifyWebhook(raw, sig) {
      if (sig !== createHmac("sha256", secret).update(raw).digest("hex")) throw new WebhookSignatureError();
      const e = JSON.parse(raw);
      return { id: e.id, type: e.type, livemode: false, created: new Date(), object: e.data.object, payloadSha256: "x" };
    },
    async refund() {
      return { id: "re" };
    },
  };
  setPaymentProviderForTests(provider);
  Object.assign(process.env, { PAYMENTS_ENABLED: "1", PAYMENTS_MODE: "test", MERCHANT_VERIFIED: "1", MERCHANT_LEGAL_NAME: "MAXIMUS VEGAS L.L.C-FZ" });
  try {
    let admin = await mk("cadm");
    await db.query("insert into user_roles (user_id, role) values ($1, 'admin')", [admin.id]);
    admin = { ...admin, roles: ["admin"], mfaAt: new Date() };
    const code = `conc-${run}`;
    const offerId = await createOfferVersion(db, admin, {
      code, kind: "membership", titleRu: "Ч", titleEn: "M", benefitsRu: "", benefitsEn: "", exclusionsRu: "", exclusionsEn: "",
      price: "50", currency: "AED", taxTreatment: "test", durationDays: "30", admission: "review", termsRu: "т", termsEn: "t", refundRu: "в", refundEn: "r",
    });
    await approveOffer(db, admin, offerId, "concurrency test approval");
    const buyer = await mk("cbuy");
    const app = await applyForMembership(db, buyer, { offer: code }, "en");
    await decideApplication(db, admin, app.id, "approved", "ok for test", "en");
    const inv = await issueInvoice(db, admin, app.id, "en");
    // Ten parallel checkout starts: exactly one active attempt and one provider session.
    const starts = await Promise.allSettled(Array.from({ length: 10 }, () => startCheckout(db, buyer, inv.id, "on", "en")));
    const urls = new Set(starts.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<string>).value));
    assert.equal(urls.size, 1, "one hosted session");
    assert.equal(created, 1);
    const [att] = await db.query<{ id: string; provider_session_id: string }>("select id, provider_session_id from payment_attempts where invoice_id = $1 and status = 'open'", [inv.id]);
    const s = sessions.get(att.provider_session_id)!;
    sessions.set(s.id, { ...s, status: "complete", paymentStatus: "paid", paymentIntentId: `pi_${run}` });
    // The same event delivered ten times in parallel: one ledger entry, one activation.
    const raw = JSON.stringify({ id: `evt_${run}`, type: "checkout.session.completed", livemode: false, data: { object: { id: s.id } } });
    const sig = createHmac("sha256", secret).update(raw).digest("hex");
    const deliveries = await Promise.all(Array.from({ length: 10 }, () => handleProviderWebhook(db, raw, sig)));
    assert.ok(deliveries.every((d) => d.status === 200 || d.status === 500));
    // Retries of anything that raced are idempotent too.
    await handleProviderWebhook(db, raw, sig);
    const [ledger] = await db.query<{ n: number }>("select count(*)::int as n from ledger_entries where invoice_id = $1", [inv.id]);
    assert.equal(ledger.n, 1);
    const [m] = await db.query<{ n: number }>("select count(*)::int as n from memberships where invoice_id = $1 and status = 'active'", [inv.id]);
    assert.equal(m.n, 1);

    // Coins: 12 parallel spends of 10 from a balance of 100 — exactly 10 succeed.
    const spender = await mk("cspend");
    await moveCoins(db, spender.id, 100, "test", "", `seed:${run}`);
    const spends = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => moveCoins(db, spender.id, -10, "test", "", `spend:${run}:${i}`)));
    assert.equal(spends.filter((r) => r.status === "fulfilled").length, 10);
    assert.equal(await balance(db, spender.id), 0);
    // Objective claimed in parallel: paid once.
    await db.query("insert into linked_game_accounts (user_id, game, handle) values ($1, 'cs2', 'h')", [spender.id]);
    await Promise.allSettled(Array.from({ length: 6 }, () => claimObjective(db, spender, "link_game")));
    assert.equal(await balance(db, spender.id), 50);

    // Quick match: two players join at the same moment and are paired with each other.
    const qa = await mk("cqa");
    const qb = await mk("cqb");
    const game = "rocket-league";
    await db.query("delete from quick_queue where game = $1", [game]);
    const joined = await Promise.all([joinQuickMatch(db, qa, game), joinQuickMatch(db, qb, game)]);
    assert.equal(joined.filter((j) => j.readyCheck).length, 1, "exactly one join creates the pairing");

    // Parties: two parties of two queue at the same moment — one ready check holds all four players.
    const pp = await Promise.all(["cpa1", "cpa2", "cpb1", "cpb2"].map((n) => mk(n)));
    const pgame = "dota2";
    await db.query("delete from quick_queue where game = $1", [pgame]);
    for (const [leader, mate] of [
      [pp[0], pp[1]],
      [pp[2], pp[3]],
    ]) {
      await createParty(db, leader, pgame);
      await inviteToParty(db, leader, mate.username);
      const [inv] = await db.query<{ id: string }>("select id from party_invites where user_id = $1 and status = 'pending'", [mate.id]);
      await respondPartyInvite(db, mate, inv.id, true);
    }
    const pj = await Promise.all([joinQuickMatch(db, pp[0], pgame), joinQuickMatch(db, pp[2], pgame)]);
    const checkId = pj.find((j) => j.readyCheck)?.readyCheck;
    assert.ok(checkId, "two simultaneous party joins are paired");
    assert.equal(pj.filter((j) => j.readyCheck).length, 1, "one pairing, opened once");
    const [held] = await db.query<{ n: number }>("select count(*)::int as n from quick_queue where held_by = $1", [checkId]);
    assert.equal(held.n, 4, "the ready check holds both parties whole");
    // All four confirm at the same moment: the match is created once.
    const answers = await Promise.all(pp.map((p) => answerReadyCheck(db, p, checkId!, true)));
    assert.equal(answers.filter((a) => a.status === "passed").length, 1, "exactly one answer completes the check");
    const [made] = await db.query<{ n: number; matches: number }>(
      "select count(*)::int as n, count(distinct m.challenge_id)::int as matches from challenge_members m join ready_checks rc on rc.challenge_id = m.challenge_id where rc.id = $1",
      [checkId],
    );
    assert.deepEqual(made, { n: 4, matches: 1 });

    // Double elimination: ten parallel referee decisions on one match advance the winner once.
    const org = await mk("cdeorg");
    const space = await createOrg(db, org, { name: `DE ${run}`, description: "" });
    const t = await createTournament(db, org, space.id, {
      name: `DE Cup ${run}`, game: "cs2", format: "double_elimination", participantType: "solo", teamSize: 1, maxParticipants: 8,
      checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC", description: "", rules: "",
    });
    await transition(db, org, t.id, "PUBLISHED");
    await transition(db, org, t.id, "REGISTRATION_OPEN");
    for (let i = 0; i < 4; i++) await register(db, await mk(`cde${i}`), t.id);
    await transition(db, org, t.id, "REGISTRATION_CLOSED");
    await transition(db, org, t.id, "IN_PROGRESS");
    const [first] = await db.query<{ id: string }>("select id from matches where tournament_id = $1 and status = 'ready' order by position limit 1", [t.id]);
    const decisions = await Promise.allSettled(Array.from({ length: 10 }, () => officialResult(db, org, first.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" })));
    assert.equal(decisions.filter((r) => r.status === "fulfilled").length, 1);
    const placed = await db.query<{ n: number }>(
      "select count(*)::int as n from matches where tournament_id = $1 and (a_reg is not null or b_reg is not null) and bracket = 'L'",
      [t.id],
    );
    assert.equal(placed[0].n, 1, "the loser dropped into the losers bracket exactly once");
    assert.equal((await verifyAuditChain(db)).valid, true);
  } finally {
    setPaymentProviderForTests(null);
    await db.close();
  }
});

// ---- Release 3: round robin and Swiss under real concurrency ----
test("swiss and round robin: results that finish a round together pair the next round and complete the event exactly once", { skip: !url }, async () => {
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    return (await sessionUser(db, s.token))!;
  };
  try {
    const org = await mk("swo");
    const space = await createOrg(db, org, { name: `Swiss ${run}`, description: "" });
    const start = async (format: "swiss" | "round_robin", n: number) => {
      const t = await createTournament(db, org, space.id, {
        name: `${format} ${run}`, game: "cs2", format, participantType: "solo", teamSize: 1, maxParticipants: 16,
        checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC", description: "", rules: "",
      });
      await transition(db, org, t.id, "PUBLISHED");
      await transition(db, org, t.id, "REGISTRATION_OPEN");
      for (let i = 0; i < n; i++) await register(db, await mk(`${format.slice(0, 2)}${i}`), t.id);
      await transition(db, org, t.id, "REGISTRATION_CLOSED");
      await transition(db, org, t.id, "IN_PROGRESS");
      return t;
    };
    const t = await start("swiss", 8);
    for (let round = 1; round <= 3; round++) {
      const games = await db.query<{ id: string }>("select id from matches where tournament_id = $1 and round = $2 and status = 'ready'", [t.id, round]);
      assert.equal(games.length, 4, `round ${round} has four games`);
      // Every game of the round decided at the same moment, each by ten racing requests. The requests are
      // interleaved across games so that the pool's connections work on different games at once.
      const all = await Promise.allSettled(
        Array.from({ length: 10 }, () => games.map((g) => officialResult(db, org, g.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" }))).flat(),
      );
      assert.equal(all.filter((r) => r.status === "fulfilled").length, 4, "one decision per game");
      const [next] = await db.query<{ n: number }>("select count(*)::int as n from matches where tournament_id = $1 and round = $2", [t.id, round + 1]);
      assert.equal(next.n, round < 3 ? 4 : 0, `round ${round + 1} paired exactly once`);
    }
    const ms = await db.query<{ a_reg: string; b_reg: string }>("select a_reg, b_reg from matches where tournament_id = $1", [t.id]);
    assert.equal(new Set(ms.map((m) => [m.a_reg, m.b_reg].sort().join("|"))).size, 12, "no rematch");
    const [done] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
    assert.equal(done.status, "COMPLETED");
    const [paired] = await db.query<{ n: number }>("select count(*)::int as n from audit_log where entity_id = $1 and action = 'tournament.swiss_round_paired'", [t.id]);
    assert.equal(paired.n, 3);
    // Round robin: the last three games decided together complete the event once.
    const rr = await start("round_robin", 4);
    const rrGames = await db.query<{ id: string; round: number }>("select id, round from matches where tournament_id = $1 order by round, position", [rr.id]);
    for (const g of rrGames.slice(0, 3)) await officialResult(db, org, g.id, { scoreA: 1, scoreB: 0, evidenceUrl: "", note: "" });
    await Promise.allSettled(
      Array.from({ length: 5 }, () => rrGames.slice(3).map((g) => officialResult(db, org, g.id, { scoreA: 0, scoreB: 1, evidenceUrl: "", note: "" }))).flat(),
    );
    const [completed] = await db.query<{ n: number }>("select count(*)::int as n from audit_log where entity_id = $1 and action = 'tournament.completed'", [rr.id]);
    assert.equal(completed.n, 1, "completed exactly once");
    const places = await db.query<{ placement: number }>("select placement from registrations where tournament_id = $1 order by placement", [rr.id]);
    assert.deepEqual(places.map((p) => p.placement), [1, 2, 3, 4]);
    assert.equal((await verifyAuditChain(db)).valid, true);
  } finally {
    await db.close();
  }
});

// ---- Release 4: the end of a main stage under real concurrency ----
test("groups: the last group results decided together create the playoff exactly once", { skip: !url }, async () => {
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    return (await sessionUser(db, s.token))!;
  };
  try {
    const org = await mk("gpo");
    const space = await createOrg(db, org, { name: `Groups ${run}`, description: "" });
    const t = await createTournament(db, org, space.id, {
      name: `groups ${run}`, game: "cs2", format: "groups", participantType: "solo", teamSize: 1, maxParticipants: 16,
      checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC", description: "", rules: "",
      settings: { groupCount: "4", groupAdvance: "2", playoffFormat: "double_elimination" },
    });
    await transition(db, org, t.id, "PUBLISHED");
    await transition(db, org, t.id, "REGISTRATION_OPEN");
    for (let i = 0; i < 12; i++) await register(db, await mk(`gp${i}`), t.id);
    await transition(db, org, t.id, "REGISTRATION_CLOSED");
    await transition(db, org, t.id, "IN_PROGRESS");
    const games = await db.query<{ id: string; group_no: number }>("select id, group_no from matches where tournament_id = $1 order by round, group_no, position", [t.id]);
    assert.equal(games.length, 12, "four groups of three: three games each");
    // All but the last game of every group first; then the four last games, each by eight racing requests.
    const last = new Map<number, string>();
    for (const g of games) last.set(g.group_no, g.id);
    for (const g of games.filter((g) => ![...last.values()].includes(g.id))) await officialResult(db, org, g.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
    const all = await Promise.allSettled(
      Array.from({ length: 8 }, () => [...last.values()].map((id) => officialResult(db, org, id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" }))).flat(),
    );
    assert.equal(all.filter((r) => r.status === "fulfilled").length, 4, "one decision per game");
    const [state] = await db.query<{ stage: number; entries: number; playoff: number; started: number }>(
      `select t.stage,
              (select count(*)::int from stage_entries e where e.tournament_id = t.id) as entries,
              (select count(*)::int from matches m where m.tournament_id = t.id and m.stage = 2) as playoff,
              (select count(*)::int from audit_log a where a.entity_id = t.id::text and a.action = 'tournament.playoff_started') as started
         from tournaments t where t.id = $1`,
      [t.id],
    );
    assert.deepEqual(state, { stage: 2, entries: 8, playoff: 14, started: 1 }, "one playoff of eight, double elimination without a reset yet");
    assert.equal((await verifyAuditChain(db)).valid, true);
  } finally {
    await db.close();
  }
});

// ---- Chains of stages (MV-STAGES-2): the end of every stage under real concurrency ----
test("chains: the last results of each stage decided together create the next stage exactly once", { skip: !url }, async () => {
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    return (await sessionUser(db, s.token))!;
  };
  try {
    const org = await mk("cho");
    const space = await createOrg(db, org, { name: `Chains ${run}`, description: "" });
    const t = await createTournament(db, org, space.id, {
      name: `chains ${run}`, game: "cs2", format: "swiss", participantType: "solo", teamSize: 1, maxParticipants: 8,
      checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC", description: "", rules: "",
      settings: { swissRounds: "1", stage2Format: "groups", stage2Size: "8", stage2GroupCount: "2", stage2GroupAdvance: "2", playoffFormat: "single_elimination" },
    });
    await transition(db, org, t.id, "PUBLISHED");
    await transition(db, org, t.id, "REGISTRATION_OPEN");
    for (let i = 0; i < 8; i++) await register(db, await mk(`ch${i}`), t.id);
    await transition(db, org, t.id, "REGISTRATION_CLOSED");
    await transition(db, org, t.id, "IN_PROGRESS");
    const state = async () =>
      (
        await db.query<{ stage: number; entries2: number; entries3: number; stage2: number; stage3: number; started: number; playoff: number }>(
          `select t.stage,
                  (select count(*)::int from stage_entries e where e.tournament_id = t.id and e.stage = 2) as entries2,
                  (select count(*)::int from stage_entries e where e.tournament_id = t.id and e.stage = 3) as entries3,
                  (select count(*)::int from matches m where m.tournament_id = t.id and m.stage = 2) as stage2,
                  (select count(*)::int from matches m where m.tournament_id = t.id and m.stage = 3) as stage3,
                  (select count(*)::int from audit_log a where a.entity_id = t.id::text and a.action = 'tournament.stage_started') as started,
                  (select count(*)::int from audit_log a where a.entity_id = t.id::text and a.action = 'tournament.playoff_started') as playoff
             from tournaments t where t.id = $1`,
          [t.id],
        )
      )[0];
    // The single Swiss round: four games, each decided by eight racing requests.
    const swiss = await db.query<{ id: string }>("select id from matches where tournament_id = $1 and stage = 1", [t.id]);
    assert.equal(swiss.length, 4);
    const first = await Promise.allSettled(
      Array.from({ length: 8 }, () => swiss.map((g) => officialResult(db, org, g.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" }))).flat(),
    );
    assert.equal(first.filter((r) => r.status === "fulfilled").length, 4, "one decision per game");
    assert.deepEqual(await state(), { stage: 2, entries2: 8, entries3: 0, stage2: 12, stage3: 0, started: 1, playoff: 0 }, "one stage of two groups of four");
    // Stage 2: all but the last game of each group, then the two last games by eight racing requests each.
    const games = await db.query<{ id: string; group_no: number }>("select id, group_no from matches where tournament_id = $1 and stage = 2 order by round, group_no, position", [t.id]);
    const last = new Map<number, string>();
    for (const g of games) last.set(g.group_no, g.id);
    for (const g of games.filter((g) => ![...last.values()].includes(g.id))) await officialResult(db, org, g.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
    const second = await Promise.allSettled(
      Array.from({ length: 8 }, () => [...last.values()].map((id) => officialResult(db, org, id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" }))).flat(),
    );
    assert.equal(second.filter((r) => r.status === "fulfilled").length, 2, "one decision per game");
    assert.deepEqual(await state(), { stage: 3, entries2: 8, entries3: 4, stage2: 12, stage3: 3, started: 1, playoff: 1 }, "one playoff of four");
    assert.equal((await verifyAuditChain(db)).valid, true);
  } finally {
    await db.close();
  }
});

// ---- Release 5: the end of an FFA round under real concurrency ----
test("ffa: the last lobby games recorded together create the next round exactly once", { skip: !url }, async () => {
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    return (await sessionUser(db, s.token))!;
  };
  try {
    const org = await mk("ffo");
    const space = await createOrg(db, org, { name: `FFA ${run}`, description: "" });
    const t = await createTournament(db, org, space.id, {
      name: `ffa ${run}`, game: "pubg", format: "ffa", participantType: "solo", teamSize: 1, maxParticipants: 32,
      checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC", description: "", rules: "",
      settings: { lobbySize: "6", ffaGames: "1", ffaAdvance: "2" },
    });
    await transition(db, org, t.id, "PUBLISHED");
    await transition(db, org, t.id, "REGISTRATION_OPEN");
    for (let i = 0; i < 18; i++) await register(db, await mk(`ff${i}`), t.id);
    await transition(db, org, t.id, "REGISTRATION_CLOSED");
    await transition(db, org, t.id, "IN_PROGRESS");
    const games = await db.query<{ id: string; lobby_id: string }>("select id, lobby_id from ffa_games where tournament_id = $1 order by id", [t.id]);
    assert.equal(games.length, 3, "three lobbies of six, one game each");
    const lines = async (g: { lobby_id: string }) =>
      (await db.query<{ registration_id: string }>("select registration_id from ffa_entries where lobby_id = $1 order by seed", [g.lobby_id])).map((r, i) => ({
        reg: r.registration_id,
        placement: String(i + 1),
        kills: "1",
      }));
    const prepared = await Promise.all(games.map(async (g) => ({ id: g.id, lines: await lines(g) })));
    const all = await Promise.allSettled(Array.from({ length: 6 }, () => prepared.map((g) => recordGame(db, org, g.id, { lines: g.lines }))).flat());
    assert.equal(all.filter((r) => r.status === "fulfilled").length, 3, "one result per game");
    const [state] = await db.query<{ lobbies: number; created: number }>(
      `select (select count(*)::int from ffa_lobbies where tournament_id = $1 and round = 2) as lobbies,
              (select count(*)::int from audit_log where entity_id = $1::text and action = 'tournament.ffa_round_created') as created`,
      [t.id],
    );
    assert.deepEqual(state, { lobbies: 1, created: 2 }, "round 2 created once: six qualifiers in one final lobby");
    assert.equal((await verifyAuditChain(db)).valid, true);
  } finally {
    await db.close();
  }
});

test("referee calls: a burst of calls from both sides opens one call per side and notifies staff once each", { skip: !url }, async () => {
  const { callReferee, closeRefereeCall } = await import("../src/server/gameday.ts");
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    return (await sessionUser(db, s.token))!;
  };
  const org = await mk("rc");
  const space = await createOrg(db, org, { name: `Calls ${run}`, description: "" });
  const t = await createTournament(db, org, space.id, {
    name: `Calls Cup ${run}`, game: "cs2", participantType: "solo", teamSize: 1, maxParticipants: 2,
    checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC", description: "", rules: "",
  });
  await transition(db, org, t.id, "PUBLISHED");
  await transition(db, org, t.id, "REGISTRATION_OPEN");
  const [a, b] = await Promise.all([mk("rca"), mk("rcb")]);
  await register(db, a, t.id);
  await register(db, b, t.id);
  await transition(db, org, t.id, "REGISTRATION_CLOSED");
  await transition(db, org, t.id, "IN_PROGRESS");
  const [m] = await db.query<{ id: string }>("select id from matches where tournament_id = $1", [t.id]);
  const burst = await Promise.all([a, b, a, b, a, b].map((u, i) => callReferee(db, u, m.id, `Call number ${i}`)));
  assert.equal(burst.filter((r) => r.created).length, 2, "one open call per side");
  assert.equal(new Set(burst.map((r) => r.id)).size, 2);
  const [n] = await db.query<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and kind = 'referee_call'", [org.id]);
  assert.equal(n.n, 2);
  const closes = await Promise.all(burst.slice(0, 2).flatMap((r) => [closeRefereeCall(db, org, r.id, "ok"), closeRefereeCall(db, org, r.id, "ok")]));
  assert.equal(closes.filter((c) => c.closed).length, 2, "each call is closed once");
  assert.equal((await verifyAuditChain(db)).valid, true);
  await db.close();
});

test("venue passes: a burst of scans of one QR admits exactly once", { skip: !url }, async () => {
  const { createVenue, submitVenue, reviewVenue, issueGuestPass, myPasses, admitPass } = await import("../src/server/venues.ts");
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    return (await sessionUser(db, s.token))!;
  };
  const owner = await mk("vo");
  const staffUser = await mk("vs");
  await db.query("insert into user_roles (user_id, role) values ($1, 'support')", [staffUser.id]);
  const holder = await mk("vh");
  const space = await createOrg(db, owner, { name: `Venue Conc ${run}`, description: "" });
  const venue = await createVenue(db, owner, space.id, { name: `Conc Hall ${run}`, kind: "club", address: "Test street 1", city: "Dubai", country: "AE", description: "", website: "" });
  await submitVenue(db, owner, venue.id);
  // The support role was granted after sign-in: the session object is refreshed by hand for the review.
  await reviewVenue(db, { ...staffUser, roles: ["support"] }, venue.id, "confirm", "");
  const from = new Date(Date.now() - 60_000).toISOString().slice(0, 16);
  const until = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16);
  await issueGuestPass(db, owner, venue.id, { username: holder.username, from, until, tz: "UTC", note: "" });
  const [pass] = await myPasses(db, holder.id);
  const results = await Promise.all(Array.from({ length: 8 }, () => admitPass(db, owner, pass.token)));
  assert.deepEqual(results.map((r) => r.result).sort(), ["admitted", ...Array(7).fill("used")]);
  const [log] = await db.query<{ admitted: number; total: number }>(
    "select count(*) filter (where result = 'admitted')::int as admitted, count(*)::int as total from venue_checkins where pass_id = $1",
    [pass.id],
  );
  assert.deepEqual([log.admitted, log.total], [1, 8]);
  assert.equal((await verifyAuditChain(db)).valid, true);
  await db.close();
});

test("messages: marketing messages sent at the same moment never pass the frequency cap; a draft sends once", { skip: !url }, async () => {
  const { createMessage, sendMessage, MARKETING_CAP } = await import("../src/server/messages.ts");
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on", marketing: "on" });
    return (await sessionUser(db, s.token))!;
  };
  // The segment is this run's accounts only: earlier runs leave the country.
  await db.query("update users set country_code = null where country_code = 'IS'");
  const marketer = { ...(await mk("mm")), roles: ["marketing" as const], mfaAt: new Date() };
  const people = await Promise.all(Array.from({ length: 5 }, (_, i) => mk(`mr${i}`)));
  await db.query("update users set country_code = 'IS' where id = any($1::uuid[])", [people.map((p) => p.id)]);
  const drafts = await Promise.all(
    Array.from({ length: 4 }, (_, i) => createMessage(db, marketer, { kind: "marketing", title: `Анонс ${i} ${run}`, body: "Текст", audience: "all", country: "IS" })),
  );
  // Four drafts sent at once, each twice (a double click).
  const results = await Promise.allSettled(drafts.flatMap((d) => [sendMessage(db, marketer, d.id), sendMessage(db, marketer, d.id)]));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 4, "each draft is sent once");
  const stats = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ sent?: number; skipped_cap?: number }>).value);
  assert.equal(stats.reduce((n, s) => n + (s.sent ?? 0), 0), 5 * MARKETING_CAP);
  assert.equal(stats.reduce((n, s) => n + (s.skipped_cap ?? 0), 0), 5 * (4 - MARKETING_CAP));
  const perPerson = await db.query<{ n: number }>(
    `select count(*)::int as n from message_recipients r join staff_messages m on m.id = r.message_id
      where r.user_id = any($1::uuid[]) and r.status = 'sent' and m.kind = 'marketing' group by r.user_id`,
    [people.map((p) => p.id)],
  );
  assert.deepEqual(
    perPerson.map((r) => r.n),
    Array(5).fill(MARKETING_CAP),
  );
  assert.equal((await verifyAuditChain(db)).valid, true);
  await db.close();
});
