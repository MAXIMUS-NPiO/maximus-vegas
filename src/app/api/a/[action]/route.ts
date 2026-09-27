import * as auth from "@/server/auth.ts";
import * as teams from "@/server/teams.ts";
import * as tournaments from "@/server/tournaments.ts";
import * as matches from "@/server/matches.ts";
import * as admin from "@/server/admin.ts";
import { fail } from "@/server/errors.ts";
import { requireUser } from "@/server/access.ts";
import { clearSessionCookie, context, errorCode, redirect, sameOrigin, sessionCookie, withParam, type Ctx } from "@/server/http.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

type Result = void | string | { to?: string; ok?: string; cookie?: string };
type Handler = (c: Ctx) => Promise<Result>;

const idOf = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : fail("invalid_input"));
const u = (c: Ctx) => requireUser(c.user);
const matchPath = (c: Ctx, id: string) => `/${c.lang}/matches/${id}`;

const handlers: Record<string, Handler> = {
  "auth.signup": async (c) => {
    const s = await auth.signUp(c.db, {
      email: c.form.email,
      username: c.form.username,
      displayName: c.form.displayName,
      password: c.form.password,
      adult: c.form.adult,
      terms: c.form.terms,
      userAgent: c.request.headers.get("user-agent") ?? "",
    });
    return { to: `/${c.lang}/hub`, ok: "welcome", cookie: sessionCookie(s.token, s.expires) };
  },
  "auth.signin": async (c) => {
    const s = await auth.signIn(c.db, {
      login: c.form.login,
      password: c.form.password,
      userAgent: c.request.headers.get("user-agent") ?? "",
      clientKey: c.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });
    const next = c.form.next && /^\/(ru|en)\//.test(c.form.next) && !c.form.next.startsWith("//") ? c.form.next : `/${c.lang}/hub`;
    return { to: next, cookie: sessionCookie(s.token, s.expires) };
  },
  "auth.signout": async (c) => {
    await auth.signOut(c.db, c.token);
    return { to: `/${c.lang}`, ok: "signed_out", cookie: clearSessionCookie() };
  },
  "account.profile": async (c) => {
    await auth.updateProfile(c.db, u(c), {
      displayName: c.form.displayName,
      country: c.form.country,
      bio: c.form.bio,
      profilePublic: c.form.profilePublic,
    });
    return { ok: "saved" };
  },
  "account.game": async (c) => {
    const game = c.form.game;
    const { isGame } = await import("@/lib/games.ts");
    if (!isGame(game)) fail("invalid_game");
    await auth.setGameAccount(c.db, u(c), game, c.form.handle);
    return { ok: "saved" };
  },
  "account.password": async (c) => {
    await auth.changePassword(c.db, u(c), c.form.current, c.form.password);
    return { ok: "password_changed" };
  },
  "account.session": async (c) => {
    await auth.revokeSession(c.db, u(c), c.form.session);
    return { ok: "session_revoked" };
  },
  "account.delete": async (c) => {
    await auth.deleteAccount(c.db, u(c), c.form.password);
    return { to: `/${c.lang}`, ok: "account_deleted", cookie: clearSessionCookie() };
  },
  "account.claim_admin": async (c) => {
    await auth.claimAdmin(c.db, u(c), c.form.token);
    return { to: `/${c.lang}/admin`, ok: "admin_granted" };
  },
  "notifications.read": async (c) => {
    await admin.markNotificationsRead(c.db, u(c));
    return { ok: "saved" };
  },
  "team.create": async (c) => {
    const t = await teams.createTeam(c.db, u(c), { name: c.form.name, tag: c.form.tag, game: c.form.game });
    return { to: `/${c.lang}/teams/${t.slug}`, ok: "team_created" };
  },
  "team.invite": async (c) => {
    await teams.inviteToTeam(c.db, u(c), idOf(c.form.team), c.form.username);
    return { ok: "invite_sent" };
  },
  "team.respond": async (c) => {
    const team = await teams.respondToInvite(c.db, u(c), idOf(c.form.invite), c.form.accept === "1");
    return c.form.accept === "1" ? { to: `/${c.lang}/teams/${team.slug}`, ok: "joined_team" } : { ok: "invite_declined" };
  },
  "team.revoke": async (c) => {
    await teams.revokeInvite(c.db, u(c), idOf(c.form.invite));
    return { ok: "saved" };
  },
  "team.leave": async (c) => {
    await teams.leaveTeam(c.db, u(c), idOf(c.form.team));
    return { to: `/${c.lang}/hub`, ok: "left_team" };
  },
  "team.remove": async (c) => {
    await teams.removeMember(c.db, u(c), idOf(c.form.team), idOf(c.form.member));
    return { ok: "saved" };
  },
  "team.role": async (c) => {
    const role = c.form.role === "owner" ? "owner" : c.form.role === "captain" ? "captain" : fail("invalid_input");
    await teams.setTeamRole(c.db, u(c), idOf(c.form.team), idOf(c.form.member), role);
    return { ok: "saved" };
  },
  "org.create": async (c) => {
    const org = await teams.createOrg(c.db, u(c), { name: c.form.name, description: c.form.description });
    return { to: `/${c.lang}/organizer/${org.slug}`, ok: "org_created" };
  },
  "org.member": async (c) => {
    await teams.addOrgMember(c.db, u(c), idOf(c.form.org), c.form.username, c.form.role);
    return { ok: "saved" };
  },
  "org.remove": async (c) => {
    await teams.removeOrgMember(c.db, u(c), idOf(c.form.org), idOf(c.form.member));
    return { ok: "saved" };
  },
  "tournament.create": async (c) => {
    const t = await tournaments.createTournament(c.db, u(c), idOf(c.form.org), tournamentInput(c));
    return { to: `/${c.lang}/organizer/t/${t.slug}`, ok: "tournament_created" };
  },
  "tournament.update": async (c) => {
    await tournaments.updateTournament(c.db, u(c), idOf(c.form.tournament), tournamentInput(c));
    return { ok: "saved" };
  },
  "tournament.transition": async (c) => {
    await tournaments.transition(c.db, u(c), idOf(c.form.tournament), c.form.to);
    return { ok: "status_changed" };
  },
  "tournament.register": async (c) => {
    const r = await tournaments.register(c.db, u(c), idOf(c.form.tournament), c.form.team ? idOf(c.form.team) : undefined);
    return { ok: r.status === "waitlisted" ? "waitlisted" : "registered" };
  },
  "tournament.withdraw": async (c) => {
    await tournaments.withdraw(c.db, u(c), idOf(c.form.tournament));
    return { ok: "withdrawn" };
  },
  "tournament.checkin": async (c) => {
    await tournaments.checkIn(c.db, u(c), idOf(c.form.tournament));
    return { ok: "checked_in" };
  },
  "tournament.checkin_window": async (c) => {
    await tournaments.setCheckInOpen(c.db, u(c), idOf(c.form.tournament), c.form.open === "1");
    return { ok: "saved" };
  },
  "tournament.checkin_override": async (c) => {
    await tournaments.organizerCheckIn(c.db, u(c), idOf(c.form.tournament), idOf(c.form.registration), c.form.checked === "1");
    return { ok: "saved" };
  },
  "tournament.seeds": async (c) => {
    const seeds: Record<string, string> = {};
    for (const [k, value] of Object.entries(c.form)) if (k.startsWith("seed_")) seeds[idOf(k.slice(5))] = value;
    await tournaments.setSeeds(c.db, u(c), idOf(c.form.tournament), seeds);
    return { ok: "saved" };
  },
  "tournament.disqualify": async (c) => {
    await tournaments.disqualify(c.db, u(c), idOf(c.form.tournament), idOf(c.form.registration), c.form.reason);
    return { ok: "saved" };
  },
  "match.submit": async (c) => {
    const id = idOf(c.form.match);
    await matches.submitResult(c.db, u(c), id, { scoreA: c.form.scoreA, scoreB: c.form.scoreB, evidenceUrl: c.form.evidence, note: c.form.note });
    return { to: matchPath(c, id), ok: "result_submitted" };
  },
  "match.confirm": async (c) => {
    const id = idOf(c.form.match);
    await matches.confirmResult(c.db, u(c), id);
    return { to: matchPath(c, id), ok: "result_confirmed" };
  },
  "match.dispute": async (c) => {
    const id = idOf(c.form.match);
    await matches.disputeResult(c.db, u(c), id, c.form.reason);
    return { to: matchPath(c, id), ok: "dispute_opened" };
  },
  "match.official": async (c) => {
    const id = idOf(c.form.match);
    await matches.officialResult(c.db, u(c), id, {
      scoreA: c.form.scoreA,
      scoreB: c.form.scoreB,
      evidenceUrl: c.form.evidence,
      note: c.form.note,
      resolution: c.form.resolution,
    });
    return { to: matchPath(c, id), ok: "result_confirmed" };
  },
  "match.noshow": async (c) => {
    const id = idOf(c.form.match);
    await matches.markNoShow(c.db, u(c), id, c.form.absent);
    return { to: matchPath(c, id), ok: "saved" };
  },
  "match.correct": async (c) => {
    const id = idOf(c.form.match);
    await matches.correctResult(c.db, u(c), id, { scoreA: c.form.scoreA, scoreB: c.form.scoreB, evidenceUrl: c.form.evidence, note: c.form.note });
    return { to: matchPath(c, id), ok: "result_corrected" };
  },
  "match.details": async (c) => {
    const id = idOf(c.form.match);
    await matches.updateMatchDetails(c.db, u(c), id, {
      roomCode: "roomCode" in c.form ? c.form.roomCode : undefined,
      scheduledAt: c.form.scheduledAt,
      timeZone: c.form.tz,
      live: c.form.live,
    });
    return { to: matchPath(c, id), ok: "saved" };
  },
  "application.create": async (c) => {
    await admin.createApplication(
      c.db,
      {
        kind: c.form.kind,
        name: c.form.name,
        email: c.form.email,
        company: c.form.company,
        message: c.form.message,
        lang: c.lang,
        consent: c.form.consent,
        website: c.form.website,
      },
      c.user,
    );
    return { ok: "application_received" };
  },
  "admin.role": async (c) => {
    await admin.setRole(c.db, u(c), idOf(c.form.user), c.form.role, c.form.grant === "1");
    return { ok: "saved" };
  },
  "admin.user_status": async (c) => {
    await admin.setUserStatus(c.db, u(c), idOf(c.form.user), c.form.status, c.form.reason);
    return { ok: "saved" };
  },
  "admin.application": async (c) => {
    await admin.setApplicationStatus(c.db, u(c), idOf(c.form.application), c.form.status);
    return { ok: "saved" };
  },
};

function tournamentInput(c: Ctx) {
  return {
    name: c.form.name,
    game: c.form.game,
    participantType: c.form.participantType,
    teamSize: c.form.teamSize,
    maxParticipants: c.form.maxParticipants,
    checkInRequired: c.form.checkInRequired,
    region: c.form.region,
    startsAt: c.form.startsAt,
    timeZone: c.form.tz,
    description: c.form.description,
    rules: c.form.rules,
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const handler = handlers[action];
  const fallbackLang = new URL(request.url).searchParams.get("lang") === "en" ? "en" : "ru";
  if (!handler) return redirect(withParam(`/${fallbackLang}`, "e", "not_found"));
  if (!sameOrigin(request)) return redirect(withParam(`/${fallbackLang}`, "e", "bad_origin"));
  let c: Ctx;
  try {
    c = await context(request);
  } catch (error) {
    console.error(`[action ${action}] context`, error);
    return redirect(withParam(`/${fallbackLang}`, "e", errorCode(error)));
  }
  try {
    const result = await handler(c);
    const r = typeof result === "string" ? { to: result } : result ?? {};
    const to = r.to ?? c.back;
    return redirect(r.ok ? withParam(to, "ok", r.ok) : to, r.cookie);
  } catch (error) {
    const code = errorCode(error);
    if (code === "server_error" || code === "db_unavailable") console.error(`[action ${action}]`, error);
    if (code === "unauthorized")
      return redirect(`/${c.lang}/signin?next=${encodeURIComponent(c.back)}&e=unauthorized`);
    return redirect(withParam(c.back, "e", code));
  }
}
