import { after } from "next/server";
import * as auth from "@/server/auth.ts";
import * as accounts from "@/server/accounts.ts";
import * as teams from "@/server/teams.ts";
import * as tournaments from "@/server/tournaments.ts";
import * as circuits from "@/server/circuits.ts";
import * as matches from "@/server/matches.ts";
import * as disputes from "@/server/disputes.ts";
import * as leaderboard from "@/server/leaderboard.ts";
import * as progression from "@/server/progression.ts";
import * as challenges from "@/server/challenges.ts";
import * as sponsors from "@/server/sponsors.ts";
import * as billing from "@/server/billing.ts";
import * as mfa from "@/server/mfa.ts";
import * as admin from "@/server/admin.ts";
import * as rosters from "@/server/rosters.ts";
import * as templates from "@/server/templates.ts";
import * as schedule from "@/server/schedule.ts";
import * as lobbies from "@/server/lobbies.ts";
import * as feedback from "@/server/feedback.ts";
import * as gameday from "@/server/gameday.ts";
import * as liveops from "@/server/liveops.ts";
import * as repair from "@/server/repair.ts";
import * as veto from "@/server/veto.ts";
import * as finder from "@/server/finder.ts";
import * as quick from "@/server/quickmatch.ts";
import * as conduct from "@/server/conduct.ts";
import * as scouting from "@/server/scouting.ts";
import * as transfers from "@/server/transfers.ts";
import * as clans from "@/server/clans.ts";
import * as partner from "@/server/partner.ts";
import * as venues from "@/server/venues.ts";
import * as messages from "@/server/messages.ts";
import * as system from "@/server/system.ts";
import * as streams from "@/server/streams.ts";
import * as academy from "@/server/academy.ts";
import { storeUpload } from "@/server/media.ts";
import { drainOutbox, mailConfigured } from "@/server/mail.ts";
import { fail } from "@/server/errors.ts";
import { requireSection, requireUser, isStaff } from "@/server/access.ts";
import type { Section } from "@/server/staff-roles.ts";
import {
  clearDraftCookie,
  clearSessionCookie,
  context,
  draftCookie,
  errorCode,
  redirect,
  sameOrigin,
  sessionCookie,
  withParam,
  type Ctx,
} from "@/server/http.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

type Result = void | string | { to?: string; ok?: string; cookie?: string | string[]; external?: boolean };
type Handler = (c: Ctx) => Promise<Result>;

const idOf = (value: string | undefined) => (value && /^[0-9a-f-]{36}$/i.test(value) ? value : fail("invalid_input"));
const u = (c: Ctx) => requireUser(c.user);
const matchPath = (c: Ctx, id: string) => `/${c.lang}/matches/${id}`;
/** Actions sent from the Game Day screen return there; from anywhere else they open the match. */
const matchOrGameDay = (c: Ctx, id: string) => (c.back.startsWith(`/${c.lang}/gameday`) ? c.back : matchPath(c, id));
/**
 * Control-centre actions: platform staff with a second factor verified in this session, holding the
 * action's section (MV-STAFF-1). Server functions check their section again.
 */
const staff = async (c: Ctx, section?: Section) => {
  const user = u(c);
  if (!isStaff(user)) fail("forbidden");
  if (section) requireSection(user, section);
  await mfa.requireStaffMfa(c.db, user);
  return user;
};

const signupDraft = (c: Ctx) => ({ email: c.form.email ?? "", username: c.form.username ?? "", displayName: c.form.displayName ?? "", marketing: c.form.marketing ?? "" });

/** What an account under a suspension sanction may still do: read, appeal, manage its own access and data. */
const RESTRICTED_OK = new Set(["auth.signout", "conduct.appeal", "notifications.read", "account.session", "account.password", "account.delete", "account.accept_terms"]);
const conductAdmin = (c: Ctx) => `/${c.lang}/admin?tab=conduct`;
const venueForm = (c: Ctx) => ({
  name: c.form.name,
  kind: c.form.kind,
  address: c.form.address,
  city: c.form.city,
  country: c.form.country,
  description: c.form.description,
  website: c.form.website,
});
/**
 * A new API key or webhook secret is shown once: an HttpOnly cookie for the integrations page only, five
 * minutes, never in the URL; "I have saved it" clears it.
 */
const oneTimeSecret = (c: Ctx, kind: "key" | "webhook", value: string, clear = false) => {
  const path = new URL(c.back, "http://local").pathname;
  const secure = process.env.NODE_ENV === "production" && process.env.MV_INSECURE_COOKIES !== "1" ? "; Secure" : "";
  const body = clear ? "" : Buffer.from(JSON.stringify({ kind, value })).toString("base64url");
  return `mv_secret=${body}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 300}${secure}`;
};

const handlers: Record<string, Handler> = {
  // ---------- Accounts ----------
  "auth.signup": async (c) => {
    const input = {
      reservation: c.form.reservation,
      email: c.form.email,
      username: c.form.username,
      displayName: c.form.displayName,
      password: c.form.password,
      adult: c.form.adult,
      terms: c.form.terms,
      marketing: c.form.marketing,
      userAgent: c.request.headers.get("user-agent") ?? "",
      lang: c.lang,
    };
    if (accounts.emailFirstMode()) {
      await accounts.signUpEmailFirst(c.db, input);
      return { to: `/${c.lang}/signup/check-email`, cookie: clearDraftCookie() };
    }
    const s = await auth.signUp(c.db, input);
    return { to: `/${c.lang}/welcome`, ok: "welcome", cookie: [sessionCookie(s.token, s.expires), clearDraftCookie()] };
  },
  "auth.signin": async (c) => {
    const s = await auth.signIn(c.db, {
      login: c.form.login,
      password: c.form.password,
      userAgent: c.request.headers.get("user-agent") ?? "",
      clientKey: c.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });
    const next = c.form.next && /^\/(ru|en)\//.test(c.form.next) && !c.form.next.startsWith("//") && !c.form.next.includes("\\") ? c.form.next : `/${c.lang}/hub`;
    return { to: next, cookie: sessionCookie(s.token, s.expires) };
  },
  "auth.signout": async (c) => {
    await auth.signOut(c.db, c.token);
    return { to: `/${c.lang}`, ok: "signed_out", cookie: clearSessionCookie() };
  },
  "auth.verify_request": async (c) => {
    await accounts.requestEmailVerification(c.db, u(c), c.lang);
    return { ok: "verification_sent" };
  },
  "auth.reset_request": async (c) => {
    await accounts.requestPasswordReset(c.db, c.form.email, c.lang);
    return { to: `/${c.lang}/forgot-password`, ok: "reset_sent" };
  },
  "auth.verify": async (c) => {
    await accounts.verifyEmail(c.db, c.form.token);
    return { to: c.user ? `/${c.lang}/settings` : `/${c.lang}/signin`, ok: "email_verified" };
  },
  "auth.activate": async (c) => {
    const s = await accounts.activateAccount(c.db, c.form.token, c.request.headers.get("user-agent") ?? "");
    return { to: `/${c.lang}/welcome`, ok: "account_activated", cookie: sessionCookie(s.token, s.expires) };
  },
  "auth.reset": async (c) => {
    const s = await accounts.resetPassword(c.db, c.form.token, c.form.password, c.request.headers.get("user-agent") ?? "");
    return { to: `/${c.lang}/hub`, ok: "password_changed", cookie: sessionCookie(s.token, s.expires) };
  },
  "account.accept_terms": async (c) => {
    await accounts.acceptCurrentTerms(c.db, u(c));
    return { ok: "saved" };
  },
  "account.marketing": async (c) => {
    await accounts.setMarketing(c.db, u(c), c.form.optIn === "1");
    return { ok: "saved" };
  },
  "account.profile": async (c) => {
    await auth.updateProfile(c.db, u(c), {
      displayName: c.form.displayName,
      country: c.form.country,
      bio: c.form.bio,
      profilePublic: c.form.profilePublic,
    });
    if ("countryCode" in c.form) await accounts.setCountry(c.db, u(c), c.form.countryCode);
    return { ok: "saved" };
  },
  "account.country": async (c) => {
    await accounts.setCountry(c.db, u(c), c.form.countryCode);
    return { ok: "saved" };
  },
  "account.game": async (c) => {
    const game = c.form.game;
    const { isGame } = await import("@/lib/games.ts");
    if (!isGame(game)) fail("invalid_game");
    const { changeGameName } = await import("@/server/game-names.ts");
    await changeGameName(c.db, u(c).id, game, c.form.handle, c.form.removeHandle);
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
    return { to: `/${c.lang}/admin/security`, ok: "admin_granted" };
  },
  "onboarding.done": async (c) => {
    await accounts.completeOnboarding(c.db, u(c));
    return { to: c.form.next === "tournaments" ? `/${c.lang}/tournaments` : `/${c.lang}/hub`, ok: "welcome" };
  },
  "notifications.read": async (c) => {
    await admin.markNotificationsRead(c.db, u(c));
    return { ok: "saved" };
  },

  // ---------- Staff second factor ----------
  "mfa.start": async (c) => {
    const user = u(c);
    if (!isStaff(user)) fail("forbidden");
    await mfa.startEnrolment(c.db, user);
    return { to: `/${c.lang}/admin/security` };
  },
  "mfa.confirm": async (c) => {
    const codes = await mfa.confirmEnrolment(c.db, u(c), c.form.code);
    const cookie = `mv_codes=${Buffer.from(codes.join(",")).toString("base64url")}; Path=/${c.lang}/admin/security; HttpOnly; SameSite=Strict; Max-Age=300${process.env.NODE_ENV === "production" && process.env.MV_INSECURE_COOKIES !== "1" ? "; Secure" : ""}`;
    return { to: `/${c.lang}/admin/security`, ok: "mfa_enrolled", cookie };
  },
  "mfa.codes_saved": async (c) => ({ to: `/${c.lang}/admin`, cookie: `mv_codes=; Path=/${c.lang}/admin/security; HttpOnly; SameSite=Strict; Max-Age=0` }),
  "mfa.verify": async (c) => {
    await mfa.verifySecondFactor(c.db, u(c), c.form.code);
    const next = c.form.next && /^\/(ru|en)\/admin/.test(c.form.next) ? c.form.next : `/${c.lang}/admin`;
    return { to: next, ok: "mfa_verified" };
  },
  "mfa.reset": async (c) => {
    const user = await staff(c);
    await mfa.resetFactor(c.db, user, idOf(c.form.user));
    return { ok: "saved" };
  },

  // ---------- Teams and organisers ----------
  "team.create": async (c) => {
    const t = await teams.createTeam(c.db, u(c), { name: c.form.name, tag: c.form.tag, game: c.form.game });
    return { to: `/${c.lang}/teams/${t.slug}`, ok: "team_created" };
  },
  "team.invite": async (c) => {
    const { reserveOrInvite } = await import("@/server/username-reservations.ts");
    const result = await reserveOrInvite(c.db, u(c), idOf(c.form.team), c.form.username);
    return { ok: result === "reserved" ? "username_reserved" : "invite_sent" };
  },
  "team.respond": async (c) => {
    const team = await teams.respondToInvite(c.db, u(c), idOf(c.form.invite), c.form.accept === "1");
    return c.form.accept === "1" ? { to: `/${c.lang}/teams/${team.slug}`, ok: "joined_team" } : { ok: "invite_declined" };
  },
  "team.reservation_revoke": async (c) => {
    const { revokeReservation } = await import("@/server/username-reservations.ts");
    await revokeReservation(c.db, u(c), idOf(c.form.reservation));
    return { ok: "saved" };
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
  "team.media": async (c) => {
    await teams.setTeamMedia(c.db, u(c), idOf(c.form.team), { logo: c.files.logo, banner: c.files.banner, clear: c.form.clear });
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

  // ---------- Tournaments ----------
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
    const answers = Object.fromEntries(Object.entries(c.form).filter(([k]) => k.startsWith("answer_")));
    const r = await tournaments.register(c.db, u(c), idOf(c.form.tournament), c.form.team ? idOf(c.form.team) : undefined, answers);
    return { ok: r.status === "pending" ? "registration_pending" : r.status === "waitlisted" ? "waitlisted" : "registered" };
  },
  "tournament.approve": async (c) => {
    const status = await tournaments.approveRegistration(c.db, u(c), idOf(c.form.tournament), idOf(c.form.registration));
    return { ok: status === "waitlisted" ? "approved_waitlisted" : "registration_approved" };
  },
  "tournament.reject": async (c) => {
    await tournaments.rejectRegistration(c.db, u(c), idOf(c.form.tournament), idOf(c.form.registration), c.form.reason);
    return { ok: "registration_rejected" };
  },
  "registration.roster": async (c) => {
    const members = (c.multi.member ?? (c.form.member ? [c.form.member] : [])).map((id) => idOf(id));
    await rosters.setRoster(c.db, u(c), idOf(c.form.tournament), idOf(c.form.registration), members);
    return { ok: "saved" };
  },
  "tournament.substitute": async (c) => {
    await rosters.substitute(c.db, u(c), idOf(c.form.tournament), idOf(c.form.registration), idOf(c.form.out), idOf(c.form.in), c.form.reason);
    return { ok: "roster_substituted" };
  },
  "tournament.reschedule": async (c) => {
    await schedule.reschedule(c.db, u(c), idOf(c.form.tournament), { round: c.form.round, at: c.form.at, timeZone: c.form.tz, shiftMinutes: c.form.shiftMinutes, force: c.form.force });
    return { ok: "rescheduled" };
  },
  "tournament.waves": async (c) => {
    await schedule.scheduleWaves(c.db, u(c), idOf(c.form.tournament), { round: c.form.round, at: c.form.at, timeZone: c.form.tz, force: c.form.force });
    return { ok: "waves_scheduled" };
  },
  "tournament.venue_add": async (c) => {
    await schedule.addVenue(c.db, u(c), idOf(c.form.tournament), { name: c.form.name, kind: c.form.kind });
    return { ok: "venue_added" };
  },
  "tournament.venue_remove": async (c) => {
    await schedule.removeVenue(c.db, u(c), idOf(c.form.tournament), idOf(c.form.venue));
    return { ok: "venue_removed" };
  },
  "tournament.rate": async (c) => {
    await feedback.rateTournament(c.db, u(c), idOf(c.form.tournament), { rating: c.form.rating, comment: c.form.comment });
    return { ok: "feedback_saved" };
  },
  "template.save": async (c) => {
    await templates.saveTemplate(c.db, u(c), idOf(c.form.tournament), { name: c.form.name, category: c.form.category });
    return { ok: "template_saved" };
  },
  "template.create": async (c) => {
    const t = await templates.createFromTemplate(c.db, u(c), idOf(c.form.template), { name: c.form.name, startsAt: c.form.startsAt, timeZone: c.form.tz });
    return { to: `/${c.lang}/organizer/t/${t.slug}`, ok: "tournament_created" };
  },
  "template.delete": async (c) => {
    await templates.deleteTemplate(c.db, u(c), idOf(c.form.template));
    return { ok: "template_deleted" };
  },
  "lobby.result": async (c) => {
    const lines = Object.keys(c.form)
      .filter((k) => k.startsWith("place_"))
      .map((k) => ({ reg: idOf(k.slice(6)), placement: c.form[k], kills: c.form[`kills_${k.slice(6)}`] }));
    await lobbies.recordGame(c.db, u(c), idOf(c.form.game), { lines, evidenceUrl: c.form.evidence, note: c.form.note });
    return { ok: c.form.correction ? "result_corrected" : "lobby_result_saved" };
  },
  "lobby.details": async (c) => {
    await lobbies.setLobbyDetails(c.db, u(c), idOf(c.form.lobby), { roomCode: c.form.roomCode, scheduledAt: c.form.scheduledAt, timeZone: c.form.tz });
    return { ok: "saved" };
  },
  "lobby.dispute": async (c) => {
    await lobbies.fileFfaDispute(c.db, u(c), idOf(c.form.game), { reason: c.form.reason, evidenceUrl: c.form.evidence });
    return { ok: "dispute_opened" };
  },
  "lobby.uphold": async (c) => {
    await lobbies.upholdFfaDispute(c.db, u(c), idOf(c.form.dispute), c.form.note);
    return { ok: "dispute_upheld" };
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
  "tournament.coorg_add": async (c) => {
    await tournaments.addCoOrganizer(c.db, u(c), idOf(c.form.tournament), c.form.username);
    return { ok: "saved" };
  },
  "tournament.coorg_remove": async (c) => {
    await tournaments.removeCoOrganizer(c.db, u(c), idOf(c.form.tournament), idOf(c.form.member));
    return { ok: "saved" };
  },
  "tournament.clone": async (c) => {
    const t = await tournaments.cloneTournament(c.db, u(c), idOf(c.form.tournament), { name: c.form.name, startsAt: c.form.startsAt, timeZone: c.form.tz });
    return { to: `/${c.lang}/organizer/t/${t.slug}`, ok: "tournament_cloned" };
  },
  "tournament.regenerate": async (c) => {
    await tournaments.regenerateMatches(c.db, u(c), idOf(c.form.tournament));
    return { ok: "bracket_regenerated" };
  },
  "tournament.banner": async (c) => {
    const user = u(c);
    const id = idOf(c.form.tournament);
    await c.db.tx(async (q) => {
      const t = await tournaments.lockTournament(q, id);
      if (!(await tournaments.canManageTournament(q, t, user))) fail("forbidden");
      const media = c.form.clear === "1" ? null : await storeUpload(q, user.id, "tournament_banner", c.files.banner);
      if (!media && c.form.clear !== "1") fail("invalid_file");
      await q.query("update tournaments set banner_media_id = $2, updated_at = now() where id = $1", [t.id, media]);
    });
    return { ok: "saved" };
  },
  "tournament.prize": async (c) => {
    const user = await staff(c);
    await tournaments.setPrizeCoins(c.db, user, idOf(c.form.tournament), c.form.coins);
    return { ok: "saved" };
  },
  "sponsor.attach": async (c) => {
    const user = await staff(c, "sponsors");
    await sponsors.attachSponsor(c.db, user, idOf(c.form.tournament), idOf(c.form.sponsor), c.form.attach === "1");
    return { ok: "saved" };
  },

  // ---------- Circuits and seasons ----------
  "circuit.create": async (c) => {
    const r = await circuits.createCircuit(c.db, u(c), idOf(c.form.org), circuitInput(c));
    return { to: `/${c.lang}/organizer/c/${r.slug}`, ok: "circuit_created" };
  },
  "circuit.update": async (c) => {
    await circuits.updateCircuit(c.db, u(c), idOf(c.form.circuit), circuitInput(c));
    return { ok: "saved" };
  },
  "circuit.member": async (c) => {
    await circuits.setCircuitMember(c.db, u(c), idOf(c.form.circuit), c.form.handle, c.form.division);
    return { ok: "saved" };
  },
  "circuit.member_remove": async (c) => {
    await circuits.removeCircuitMember(c.db, u(c), idOf(c.form.circuit), c.form.handle);
    return { ok: "saved" };
  },
  "circuit.close": async (c) => {
    const r = await circuits.closeSeason(c.db, u(c), idOf(c.form.circuit), { nextSeason: c.form.nextSeason, createNext: c.form.createNext });
    return r.nextSlug ? { to: `/${c.lang}/organizer/c/${r.nextSlug}`, ok: "season_closed" } : { ok: "season_closed" };
  },

  // ---------- Matches, disputes, leaderboard ----------
  "match.submit": async (c) => {
    const id = idOf(c.form.match);
    await matches.submitResult(c.db, u(c), id, { scoreA: c.form.scoreA, scoreB: c.form.scoreB, evidenceUrl: c.form.evidence, note: c.form.note });
    return { to: matchPath(c, id), ok: "result_submitted" };
  },
  "match.confirm": async (c) => {
    const id = idOf(c.form.match);
    await matches.confirmResult(c.db, u(c), id);
    return { to: matchOrGameDay(c, id), ok: "result_confirmed" };
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
      venueId: "venueId" in c.form ? c.form.venueId : undefined,
      force: c.form.force,
    });
    return { to: matchPath(c, id), ok: "saved" };
  },
  "match.format": async (c) => {
    const id = idOf(c.form.match);
    await matches.setMatchFormat(c.db, u(c), id, {
      series: c.form.series,
      pointsWin: c.form.pointsWin,
      pointsDraw: c.form.pointsDraw,
      pointsLoss: c.form.pointsLoss,
      pointsBye: c.form.pointsBye,
    });
    return { to: matchPath(c, id), ok: "match_format_saved" };
  },
  "match.checkin": async (c) => {
    const id = idOf(c.form.match);
    await tournaments.matchCheckIn(c.db, u(c), id);
    return { to: matchOrGameDay(c, id), ok: "checked_in" };
  },
  "match.call": async (c) => {
    const id = idOf(c.form.match);
    const r = await gameday.callReferee(c.db, u(c), id, c.form.message);
    return { to: matchOrGameDay(c, id), ok: r.created ? "referee_called" : r.escalated ? "referee_call_escalated" : "referee_call_exists" };
  },
  "match.pause": async (c) => {
    const id = idOf(c.form.match);
    const r = await liveops.pauseMatch(c.db, u(c), id, c.form.reason);
    return { ok: r.changed ? "match_paused" : "saved" };
  },
  "match.resume": async (c) => {
    const id = idOf(c.form.match);
    const r = await liveops.resumeMatch(c.db, u(c), id);
    return { ok: r.changed ? "match_resumed" : "saved" };
  },
  "incident.open": async (c) => {
    await liveops.openIncident(c.db, u(c), idOf(c.form.tournament), {
      kind: c.form.kind,
      priority: c.form.priority,
      matchId: c.form.match ? idOf(c.form.match) : "",
      message: c.form.message,
    });
    return { ok: "incident_opened" };
  },
  "incident.assign": async (c) => {
    await liveops.assignIncident(c.db, u(c), idOf(c.form.incident), c.form.assignee);
    return { ok: "saved" };
  },
  "incident.priority": async (c) => {
    await liveops.setIncidentPriority(c.db, u(c), idOf(c.form.incident), c.form.priority);
    return { ok: "saved" };
  },
  "incident.escalate": async (c) => {
    const r = await liveops.escalateIncident(c.db, u(c), idOf(c.form.incident), c.form.note);
    return { ok: r.escalated ? "incident_escalated" : "saved" };
  },
  "incident.resolve": async (c) => {
    const r = await liveops.resolveIncident(c.db, u(c), idOf(c.form.incident), c.form.note);
    return { ok: r.closed ? "incident_resolved" : "saved" };
  },
  "finder.post": async (c) => {
    await finder.createPost(c.db, u(c), {
      kind: c.form.kind,
      game: c.form.game,
      teamId: c.form.team,
      region: c.form.region,
      roles: c.form.roles,
      languages: c.form.languages,
      level: c.form.level,
      schedule: c.form.schedule,
      note: c.form.note,
      slots: c.form.slots,
    });
    return { ok: "finder_posted" };
  },
  "finder.close": async (c) => {
    await finder.closePost(c.db, u(c), idOf(c.form.post));
    return { ok: "saved" };
  },
  "finder.apply": async (c) => {
    const r = await finder.applyToPost(c.db, u(c), idOf(c.form.post), c.form.message);
    return { ok: r.created ? "finder_applied" : "finder_already_applied" };
  },
  "finder.withdraw": async (c) => {
    await finder.withdrawApplication(c.db, u(c), idOf(c.form.application));
    return { ok: "saved" };
  },
  "finder.decide": async (c) => {
    const accept = c.form.accept === "1";
    const r = await finder.decideApplication(c.db, u(c), idOf(c.form.application), accept);
    return { ok: r.changed ? (accept ? "finder_accepted" : "finder_declined") : "saved" };
  },
  "match.veto": async (c) => {
    const id = idOf(c.form.match);
    const state = await veto.vetoMap(c.db, u(c), id, c.form.map);
    return { to: matchOrGameDay(c, id), ok: state.complete ? "veto_done" : "veto_saved" };
  },
  "match.veto_reset": async (c) => {
    const id = idOf(c.form.match);
    const r = await veto.resetVeto(c.db, u(c), id, c.form.reason);
    return { to: matchPath(c, id), ok: r.changed ? "veto_reset" : "saved" };
  },
  "match.repair": async (c) => {
    const id = idOf(c.form.match);
    const plan = await repair.repairBracket(c.db, u(c), id, {
      scoreA: c.form.scoreA,
      scoreB: c.form.scoreB,
      note: c.form.note,
      plan: c.form.plan,
      evidenceUrl: c.form.evidence,
    });
    return { to: matchPath(c, id), ok: plan.steps.some((s) => s.kind !== "replace") ? "bracket_repaired" : "result_corrected" };
  },
  "match.call_close": async (c) => {
    const r = await gameday.closeRefereeCall(c.db, u(c), idOf(c.form.call), c.form.note);
    return { to: matchPath(c, r.matchId), ok: r.closed ? "referee_call_closed" : "saved" };
  },
  "dispute.file": async (c) => {
    const id = idOf(c.form.match);
    const user = u(c);
    const media = c.files.evidenceImage ? await storeUpload(c.db, user.id, "evidence", c.files.evidenceImage) : null;
    await disputes.fileDispute(c.db, user, id, { reason: c.form.reason, evidenceUrl: c.form.evidence, evidenceMediaId: media });
    return { to: matchPath(c, id), ok: "dispute_opened" };
  },
  "dispute.decide": async (c) => {
    await disputes.decideDispute(c.db, u(c), idOf(c.form.dispute), c.form.decision, c.form.note);
    return { ok: c.form.decision === "overturn" ? "dispute_overturned" : "dispute_upheld" };
  },
  "score.submit": async (c) => {
    const r = await leaderboard.submitScore(c.db, u(c), idOf(c.form.tournament), scoreInput(c));
    return { ok: r.review === "pending" ? "score_flagged" : "score_saved" };
  },
  "score.log": async (c) => {
    const r = await leaderboard.submitScore(c.db, u(c), idOf(c.form.tournament), { ...scoreInput(c), registration: c.form.registration }, true);
    return { ok: r.review === "pending" ? "score_flagged" : "score_saved" };
  },
  "score.review": async (c) => {
    await leaderboard.reviewScore(c.db, u(c), idOf(c.form.entry), c.form.decision, c.form.note);
    return { ok: "saved" };
  },

  // ---------- Progression ----------
  "objective.claim": async (c) => {
    await progression.claimObjective(c.db, u(c), c.form.objective);
    return { ok: "reward_claimed" };
  },
  "pass.claim": async (c) => {
    await progression.claimPassTier(c.db, u(c), c.form.tier, c.form.track);
    return { ok: "reward_claimed" };
  },
  "pass.unlock": async (c) => {
    await progression.unlockPremium(c.db, u(c));
    return { ok: "premium_unlocked" };
  },
  "shop.buy": async (c) => {
    await progression.buyCosmetic(c.db, u(c), c.form.item);
    return { ok: "item_bought" };
  },
  "cosmetic.equip": async (c) => {
    await progression.equipCosmetic(c.db, u(c), c.form.item);
    return { ok: "saved" };
  },
  "referral.redeem": async (c) => {
    await progression.redeemReferral(c.db, u(c), c.form.code);
    return { ok: "reward_claimed" };
  },

  // ---------- Challenges and quick match ----------
  "challenge.create": async (c) => {
    await challenges.createChallenge(c.db, u(c), { opponent: c.form.opponent, game: c.form.game, message: c.form.message });
    return { to: `/${c.lang}/challenges`, ok: "challenge_sent" };
  },
  "challenge.respond": async (c) => {
    await challenges.respondChallenge(c.db, u(c), idOf(c.form.challenge), c.form.accept === "1");
    return { ok: "saved" };
  },
  "challenge.cancel": async (c) => {
    await challenges.cancelChallenge(c.db, u(c), idOf(c.form.challenge));
    return { ok: "saved" };
  },
  "challenge.report": async (c) => {
    await challenges.reportChallenge(c.db, u(c), idOf(c.form.challenge), {
      result: c.form.result,
      myScore: c.form.myScore,
      theirScore: c.form.theirScore,
      evidenceUrl: c.form.evidence,
    });
    return { ok: "result_submitted" };
  },
  "challenge.confirm": async (c) => {
    await challenges.confirmChallenge(c.db, u(c), idOf(c.form.challenge));
    return { ok: "result_confirmed" };
  },
  "challenge.dispute": async (c) => {
    await challenges.disputeChallenge(c.db, u(c), idOf(c.form.challenge), c.form.reason);
    return { ok: "dispute_opened" };
  },
  "challenge.resolve": async (c) => {
    const user = await staff(c, "challenges");
    await challenges.resolveChallenge(c.db, user, idOf(c.form.challenge), c.form.winner, c.form.note);
    return { ok: "saved" };
  },
  "quick.join": async (c) => {
    const r = await quick.joinQuickMatch(c.db, u(c), c.form.game, c.form.region);
    return { to: `/${c.lang}/matchmaking`, ok: r.readyCheck ? "quick_ready_check" : "quick_queued" };
  },
  "quick.leave": async (c) => {
    await quick.leaveQuickMatch(c.db, u(c));
    return { to: `/${c.lang}/matchmaking`, ok: "quick_left" };
  },
  "quick.ready": async (c) => {
    const r = await quick.answerReadyCheck(c.db, u(c), c.form.check, true);
    // The deadline had passed: the check is settled (and committed); the player sees why nothing started.
    if (r.expired) fail("ready_check_closed");
    return { to: `/${c.lang}/matchmaking`, ok: r.status === "passed" ? "quick_matched" : r.status === "pending" ? "quick_ready" : "quick_requeued" };
  },
  "quick.decline": async (c) => {
    const r = await quick.answerReadyCheck(c.db, u(c), c.form.check, false);
    if (r.expired) fail("ready_check_closed");
    return { to: `/${c.lang}/matchmaking`, ok: "quick_declined" };
  },
  "party.create": async (c) => {
    await quick.createParty(c.db, u(c), c.form.game);
    return { to: `/${c.lang}/matchmaking`, ok: "party_created" };
  },
  "party.invite": async (c) => {
    const r = await quick.inviteToParty(c.db, u(c), c.form.username);
    return { to: `/${c.lang}/matchmaking`, ok: r.created ? "party_invited" : "party_already_invited" };
  },
  "party.revoke": async (c) => {
    await quick.revokePartyInvite(c.db, u(c), c.form.invite);
    return { to: `/${c.lang}/matchmaking`, ok: "party_invite_revoked" };
  },
  "party.respond": async (c) => {
    const r = await quick.respondPartyInvite(c.db, u(c), c.form.invite, c.form.accept === "1");
    return { to: `/${c.lang}/matchmaking`, ok: r.joined ? "party_joined" : "party_declined" };
  },
  "party.leave": async (c) => {
    const r = await quick.leaveParty(c.db, u(c));
    return { to: `/${c.lang}/matchmaking`, ok: r.disbanded ? "party_disbanded" : "party_left" };
  },
  "party.remove": async (c) => {
    await quick.removeFromParty(c.db, u(c), c.form.member);
    return { to: `/${c.lang}/matchmaking`, ok: "party_removed" };
  },

  // ---------- Scouting ----------
  "scout.save": async (c) => {
    const r = await scouting.saveFilter(c.db, u(c), c.form.name, c.form);
    return { ok: r.replaced ? "filter_replaced" : "filter_saved" };
  },
  "scout.delete": async (c) => {
    await scouting.deleteFilter(c.db, u(c), c.form.filter);
    return { ok: "filter_deleted" };
  },
  "scout.watch": async (c) => {
    const r = await scouting.watchPlayer(c.db, u(c), c.form.username, c.form.note);
    return { ok: r.created ? "watch_added" : "watch_updated" };
  },
  "scout.unwatch": async (c) => {
    await scouting.unwatchPlayer(c.db, u(c), c.form.username);
    return { ok: "watch_removed" };
  },

  // ---------- Transfers ----------
  "transfer.propose": async (c) => {
    const r = await transfers.proposeTransfer(c.db, u(c), c.form.team, c.form.username, c.form.note);
    return { ok: r.created ? "transfer_proposed" : "transfer_exists" };
  },
  "transfer.answer": async (c) => {
    const answer = c.form.answer === "accept" ? "accept" : c.form.answer === "cancel" ? "cancel" : "decline";
    const r = await transfers.answerTransfer(c.db, u(c), c.form.transfer, answer);
    return { ok: r.status === "completed" ? "transfer_completed" : r.status === "proposed" ? "transfer_agreed" : r.status === "cancelled" ? "transfer_cancelled" : "transfer_declined" };
  },
  "transfer.dispute": async (c) => {
    await transfers.disputeTransfer(c.db, u(c), c.form.transfer, c.form.reason);
    return { ok: "transfer_disputed" };
  },
  "transfer.decide": async (c) => {
    const user = await staff(c, "conduct");
    mfa.requireStepUp(user);
    const reverse = c.form.reverse === "1";
    await transfers.decideTransferDispute(c.db, user, c.form.dispute, reverse, c.form.decision);
    return { to: conductAdmin(c), ok: reverse ? "transfer_reversed" : "transfer_upheld" };
  },

  // ---------- Venues and passes ----------
  "venue.create": async (c) => {
    await venues.createVenue(c.db, u(c), c.form.org, venueForm(c));
    return { ok: "venue_created" };
  },
  "venue.update": async (c) => {
    const r = await venues.updateVenue(c.db, u(c), c.form.venue, venueForm(c));
    return { ok: r.resubmitted ? "venue_resubmitted" : "venue_saved" };
  },
  "venue.submit": async (c) => {
    await venues.submitVenue(c.db, u(c), c.form.venue);
    return { ok: "venue_submitted" };
  },
  "venue.review": async (c) => {
    const user = await staff(c, "venues");
    mfa.requireStepUp(user);
    await venues.reviewVenue(c.db, user, c.form.venue, c.form.decision, c.form.note);
    return { to: `/${c.lang}/admin?tab=venues`, ok: "venue_reviewed" };
  },
  "tournament.venue_set": async (c) => {
    await venues.setTournamentVenue(c.db, u(c), c.form.tournament, c.form.venue);
    return { ok: "saved" };
  },
  "pass.event": async (c) => {
    const p = await venues.eventPass(c.db, u(c), c.form.tournament);
    return { to: `/${c.lang}/passes#pass-${p.id}`, ok: "pass_ready" };
  },
  "pass.guest": async (c) => {
    await venues.issueGuestPass(c.db, u(c), c.form.venue, { username: c.form.username, from: c.form.from, until: c.form.until, tz: c.form.tz, note: c.form.note });
    return { ok: "pass_issued" };
  },
  "pass.revoke": async (c) => {
    await venues.revokePass(c.db, u(c), c.form.pass);
    return { ok: "pass_revoked" };
  },
  "pass.admit": async (c) => {
    // A refusal is a result, not an error: it is logged and shown, never rolled back.
    const r = await venues.admitPass(c.db, u(c), c.form.token);
    return r.result === "admitted" ? { ok: "pass_admitted" } : { to: withParam(c.back, "e", `pass_${r.result}`) };
  },

  // ---------- Partner integrations: API keys, webhooks ----------
  "integrations.key_create": async (c) => {
    const r = await partner.createApiKey(c.db, u(c), c.form.org, c.form.name);
    return { ok: "api_key_created", cookie: oneTimeSecret(c, "key", r.key) };
  },
  "integrations.key_revoke": async (c) => {
    await partner.revokeApiKey(c.db, u(c), c.form.key);
    return { ok: "api_key_revoked" };
  },
  "integrations.webhook_create": async (c) => {
    const r = await partner.createWebhook(c.db, u(c), c.form.org, c.form.url, c.multi.events ?? []);
    return { ok: "webhook_created", cookie: oneTimeSecret(c, "webhook", r.secret) };
  },
  "integrations.webhook_rotate": async (c) => {
    const r = await partner.rotateWebhookSecret(c.db, u(c), c.form.endpoint);
    return { ok: "webhook_rotated", cookie: oneTimeSecret(c, "webhook", r.secret) };
  },
  "integrations.webhook_toggle": async (c) => {
    const active = c.form.active === "1";
    await partner.setWebhookActive(c.db, u(c), c.form.endpoint, active);
    return { ok: active ? "webhook_enabled" : "webhook_disabled" };
  },
  "integrations.webhook_test": async (c) => {
    await partner.sendTestEvent(c.db, u(c), c.form.endpoint);
    return { ok: "webhook_test_sent" };
  },
  "integrations.delivery_retry": async (c) => {
    await partner.retryDelivery(c.db, u(c), c.form.delivery);
    return { ok: "webhook_retry" };
  },
  "integrations.secret_hide": async (c) => ({ cookie: oneTimeSecret(c, "key", "", true) }),

  // ---------- Clans and clan wars ----------
  "clan.create": async (c) => {
    const clan = await clans.createClan(c.db, u(c), { name: c.form.name, tag: c.form.tag, description: c.form.description });
    return { to: `/${c.lang}/clans/${clan.slug}`, ok: "clan_created" };
  },
  "clan.update": async (c) => {
    await clans.updateClan(c.db, u(c), c.form.clan, { description: c.form.description });
    return { ok: "clan_updated" };
  },
  "clan.invite": async (c) => {
    await clans.inviteToClan(c.db, u(c), c.form.clan, c.form.username);
    return { ok: "clan_invited" };
  },
  "clan.respond": async (c) => {
    const accept = c.form.accept === "1";
    const r = await clans.respondClanInvite(c.db, u(c), c.form.invite, accept);
    return accept ? { to: `/${c.lang}/clans/${r.slug}`, ok: "clan_joined" } : { ok: "clan_invite_declined" };
  },
  "clan.revoke": async (c) => {
    await clans.revokeClanInvite(c.db, u(c), c.form.invite);
    return { ok: "clan_invite_revoked" };
  },
  "clan.leave": async (c) => {
    const r = await clans.leaveClan(c.db, u(c), c.form.clan);
    return { to: `/${c.lang}/clans`, ok: r.disbanded ? "clan_disbanded" : "clan_left" };
  },
  "clan.remove": async (c) => {
    await clans.removeClanMember(c.db, u(c), c.form.clan, c.form.member);
    return { ok: "clan_member_removed" };
  },
  "clan.role": async (c) => {
    await clans.setClanRole(c.db, u(c), c.form.clan, c.form.member, c.form.role);
    return { ok: "clan_role_set" };
  },
  "war.propose": async (c) => {
    await clans.proposeWar(c.db, u(c), c.form.clan, {
      opponent: c.form.opponent,
      game: c.form.game,
      sideSize: c.form.size,
      bestOf: c.form.bestOf,
      at: c.form.at,
      tz: c.form.tz,
      lineup: c.multi.lineup ?? [],
      message: c.form.message,
    });
    return { ok: "war_proposed" };
  },
  "war.answer": async (c) => {
    const r = await clans.answerWar(c.db, u(c), c.form.war, c.form.answer === "accept" ? "accept" : "decline", c.multi.lineup ?? []);
    return { ok: r.status === "accepted" ? "war_accepted" : "war_declined" };
  },
  "war.cancel": async (c) => {
    await clans.cancelWar(c.db, u(c), c.form.war);
    return { ok: "war_cancelled" };
  },
  "war.lineup": async (c) => {
    await clans.setWarLineup(c.db, u(c), c.form.war, c.multi.lineup ?? []);
    return { ok: "war_lineup_saved" };
  },
  "war.report": async (c) => {
    await clans.reportWar(c.db, u(c), c.form.war, c.form.mine, c.form.theirs);
    return { ok: "war_reported" };
  },
  "war.confirm": async (c) => {
    await clans.confirmWar(c.db, u(c), c.form.war);
    return { ok: "war_confirmed" };
  },
  "war.dispute": async (c) => {
    await clans.disputeWar(c.db, u(c), c.form.war, c.form.reason);
    return { ok: "war_disputed" };
  },
  "war.decide": async (c) => {
    const user = await staff(c, "conduct");
    mfa.requireStepUp(user);
    await clans.decideWar(c.db, user, c.form.war, c.form.outcome, c.form.decision);
    return { to: conductAdmin(c), ok: "war_decided" };
  },

  // ---------- Fair play: reports, sanctions, appeals ----------
  "conduct.report": async (c) => {
    const r = await conduct.fileReport(c.db, u(c), { username: c.form.username, rule: c.form.rule, context: c.form.context, description: c.form.description, evidence: c.form.evidence });
    return { to: `/${c.lang}/conduct`, ok: r.created ? "report_filed" : "report_exists" };
  },
  "conduct.appeal": async (c) => {
    await conduct.fileAppeal(c.db, u(c), c.form.sanction, c.form.statement, c.form.evidence);
    return { to: `/${c.lang}/conduct`, ok: "appeal_filed" };
  },
  "conduct.take": async (c) => {
    await conduct.takeReport(c.db, await staff(c, "conduct"), c.form.report);
    return { to: conductAdmin(c), ok: "saved" };
  },
  "conduct.dismiss": async (c) => {
    await conduct.dismissReport(c.db, await staff(c, "conduct"), c.form.report, c.form.reason);
    return { to: conductAdmin(c), ok: "report_dismissed" };
  },
  "conduct.sanction": async (c) => {
    const user = await staff(c, "conduct");
    mfa.requireStepUp(user);
    await conduct.issueSanction(c.db, user, {
      username: c.form.username,
      kind: c.form.kind,
      protective: c.form.protective,
      rule: c.form.rule,
      confidence: c.form.confidence,
      days: c.form.days,
      hours: c.form.hours,
      evidence: c.form.evidence,
      decision: c.form.decision,
      report: c.form.report,
    });
    return { to: conductAdmin(c), ok: "sanction_issued" };
  },
  "conduct.revoke": async (c) => {
    const user = await staff(c, "conduct");
    mfa.requireStepUp(user);
    await conduct.revokeSanction(c.db, user, c.form.sanction, c.form.reason);
    return { to: conductAdmin(c), ok: "sanction_revoked" };
  },
  "conduct.decide": async (c) => {
    const user = await staff(c, "conduct");
    mfa.requireStepUp(user);
    await conduct.decideAppeal(c.db, user, c.form.appeal, c.form.grant === "1", c.form.decision);
    return { to: conductAdmin(c), ok: "appeal_decided" };
  },
  "conduct.rule": async (c) => {
    const user = await staff(c, "conduct");
    mfa.requireStepUp(user);
    const r = await conduct.publishRule(c.db, user, {
      code: c.form.code,
      titleRu: c.form.titleRu,
      titleEn: c.form.titleEn,
      bodyRu: c.form.bodyRu,
      bodyEn: c.form.bodyEn,
      sourceRu: c.form.sourceRu,
      sourceEn: c.form.sourceEn,
    });
    return { to: conductAdmin(c), ok: r.version > 1 ? "rule_versioned" : "rule_published" };
  },

  // ---------- Membership and payments ----------
  "membership.apply": async (c) => {
    const r = await billing.applyForMembership(c.db, u(c), { offer: c.form.offer, objective: c.form.objective }, c.lang);
    return { to: `/${c.lang}/billing?ref=${encodeURIComponent(r.reference)}`, ok: "application_saved" };
  },
  "membership.withdraw": async (c) => {
    await billing.withdrawApplication(c.db, u(c), idOf(c.form.application));
    return { ok: "saved" };
  },
  "billing.checkout": async (c) => {
    const url = await billing.startCheckout(c.db, u(c), idOf(c.form.invoice), c.form.accept, c.lang);
    return { to: url, external: true };
  },
  "billing.decide": async (c) => {
    const user = await staff(c, "memberships");
    await billing.decideApplication(c.db, user, idOf(c.form.application), c.form.status, c.form.note, c.lang);
    return { ok: "saved" };
  },
  "billing.invoice": async (c) => {
    const user = await staff(c, "payments");
    await billing.issueInvoice(c.db, user, idOf(c.form.application), c.lang);
    return { ok: "invoice_issued" };
  },
  "billing.void": async (c) => {
    const user = await staff(c, "payments");
    await billing.voidInvoice(c.db, user, idOf(c.form.invoice), c.form.reason);
    return { ok: "saved" };
  },
  "billing.refund": async (c) => {
    const user = await staff(c, "payments");
    await billing.refundInvoice(c.db, user, idOf(c.form.invoice), c.form.amount);
    return { ok: "refund_requested" };
  },
  "billing.reconcile": async (c) => {
    await staff(c, "payments");
    await billing.reconcileAttempt(c.db, idOf(c.form.attempt), "admin");
    return { ok: "saved" };
  },
  "offer.create": async (c) => {
    const user = await staff(c, "offers");
    await billing.createOfferVersion(c.db, user, c.form);
    return { ok: "saved" };
  },
  "offer.approve": async (c) => {
    const user = await staff(c, "offers");
    await billing.approveOffer(c.db, user, idOf(c.form.offer), c.form.approvalRef);
    return { ok: "saved" };
  },
  "offer.retire": async (c) => {
    const user = await staff(c, "offers");
    await billing.retireOffer(c.db, user, idOf(c.form.offer));
    return { ok: "saved" };
  },
  "membership.set": async (c) => {
    const user = await staff(c, "memberships");
    await billing.setMembershipState(c.db, user, idOf(c.form.membership), { status: c.form.status, endsAt: c.form.endsAt, reason: c.form.reason });
    return { ok: "saved" };
  },

  // ---------- Partner applications and administration ----------
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
    const user = await staff(c);
    mfa.requireStepUp(user);
    await admin.setRole(c.db, user, idOf(c.form.user), c.form.role, c.form.grant === "1");
    return { ok: "saved" };
  },
  "admin.user_status": async (c) => {
    const user = await staff(c);
    mfa.requireStepUp(user);
    await admin.setUserStatus(c.db, user, idOf(c.form.user), c.form.status, c.form.reason);
    return { ok: "saved" };
  },
  "admin.application": async (c) => {
    const user = await staff(c, "applications");
    await admin.setApplicationStatus(c.db, user, idOf(c.form.application), c.form.status);
    return { ok: "saved" };
  },
  "sponsor.create": async (c) => {
    const user = await staff(c, "sponsors");
    await sponsors.createSponsor(c.db, user, { name: c.form.name, tier: c.form.tier, website: c.form.website, logo: c.files.logo });
    return { ok: "saved" };
  },
  "sponsor.toggle": async (c) => {
    const user = await staff(c, "sponsors");
    await sponsors.setSponsorActive(c.db, user, idOf(c.form.sponsor), c.form.active === "1");
    return { ok: "saved" };
  },
  // ---------- Streams and recordings (MV-MEDIA-1) ----------
  "stream.add": async (c) => {
    await streams.addStream(c.db, u(c), c.form.tournament, {
      url: c.form.url,
      title: c.form.title,
      kind: c.form.kind,
      match: c.form.match,
      language: c.form.language,
      startsAt: c.form.startsAt,
      tz: c.form.tz,
      rights: c.form.rights,
    });
    return { ok: "stream_added" };
  },
  "stream.remove": async (c) => {
    await streams.removeStream(c.db, u(c), c.form.stream);
    return { ok: "stream_removed" };
  },
  // ---------- Academy: coaches, programmes, training (MV-ACADEMY-1) ----------
  "coach.save": async (c) => {
    const r = await academy.saveCoachProfile(c.db, u(c), {
      headline: c.form.headline,
      bio: c.form.bio,
      experience: c.form.experience,
      games: c.multi.games ?? [],
      languages: c.multi.languages ?? [],
      formats: c.multi.formats ?? [],
      city: c.form.city,
      accepting: c.form.accepting,
    });
    return { ok: r.resubmitted ? "coach_resubmitted" : "coach_saved" };
  },
  "coach.submit": async (c) => {
    await academy.submitCoach(c.db, u(c));
    return { ok: "coach_submitted" };
  },
  "coach.review": async (c) => {
    const user = await staff(c, "academy");
    await academy.reviewCoach(c.db, user, c.form.coach, c.form.decision, c.form.note);
    return { ok: "coach_reviewed" };
  },
  "programme.save": async (c) => {
    await academy.saveProgramme(c.db, u(c), c.form.programme || null, {
      title: c.form.title,
      game: c.form.game,
      level: c.form.level,
      format: c.form.format,
      description: c.form.description,
      sessions: c.form.sessions,
      minutes: c.form.minutes,
    });
    return { ok: "programme_saved" };
  },
  "programme.status": async (c) => {
    await academy.setProgrammeStatus(c.db, u(c), c.form.programme, c.form.status);
    return { ok: "saved" };
  },
  "training.request": async (c) => {
    const r = await academy.requestTraining(c.db, u(c), c.form.coach, { programme: c.form.programme, game: c.form.game, goal: c.form.goal, availability: c.form.availability });
    return { to: `/${c.lang}/training/${r.id}`, ok: "training_requested" };
  },
  "training.answer": async (c) => {
    await academy.answerRequest(c.db, u(c), c.form.request, c.form.decision === "accept", c.form.note);
    return { ok: "training_answered" };
  },
  "training.cancel": async (c) => {
    await academy.cancelRequest(c.db, u(c), c.form.request);
    return { ok: "training_cancelled" };
  },
  "training.complete": async (c) => {
    await academy.completeRequest(c.db, u(c), c.form.request);
    return { ok: "training_completed" };
  },
  "training.session": async (c) => {
    await academy.scheduleSession(c.db, u(c), c.form.request, { startsAt: c.form.startsAt, tz: c.form.tz, minutes: c.form.minutes, place: c.form.place });
    return { ok: "session_scheduled" };
  },
  "training.session_status": async (c) => {
    await academy.setSessionStatus(c.db, u(c), c.form.session, c.form.status);
    return { ok: "session_updated" };
  },
  "training.progress": async (c) => {
    await academy.addProgress(c.db, u(c), c.form.request, {
      kind: c.form.kind,
      body: c.form.body,
      evidence: c.form.evidence,
      timeMark: c.form.timeMark,
      metric: c.form.metric,
      value: c.form.value,
      session: c.form.session,
    });
    return { ok: "progress_added" };
  },
  // ---------- Portal-team messages and system controls (MV-STAFF-1) ----------
  "message.create": async (c) => {
    const user = await staff(c, "messages");
    await messages.createMessage(c.db, user, c.form);
    return { ok: "message_saved" };
  },
  "message.update": async (c) => {
    const user = await staff(c, "messages");
    await messages.updateMessage(c.db, user, idOf(c.form.message), c.form);
    return { ok: "message_saved" };
  },
  "message.copy": async (c) => {
    const user = await staff(c, "messages");
    await messages.copyMessage(c.db, user, idOf(c.form.message), c.form.as);
    return { ok: "message_saved" };
  },
  "message.delete": async (c) => {
    const user = await staff(c, "messages");
    await messages.deleteMessage(c.db, user, idOf(c.form.message));
    return { ok: "message_deleted" };
  },
  "message.send": async (c) => {
    const user = await staff(c, "messages");
    await messages.sendMessage(c.db, user, idOf(c.form.message));
    return { ok: "message_sent" };
  },
  "system.flag": async (c) => {
    const user = await staff(c, "system");
    await system.setFlag(c.db, user, c.form.key, c.form.on === "1", c.form.note);
    return { ok: "flag_saved" };
  },
  "system.maintenance": async (c) => {
    const user = await staff(c, "system");
    const on = c.form.on === "1";
    await system.setFlag(c.db, user, "maintenance", on, c.form.note);
    return { ok: on ? "maintenance_on" : "maintenance_off" };
  },
  "outbox.drain": async (c) => {
    await staff(c, "outbox");
    const r = await drainOutbox(c.db, 25);
    return { ok: r.configured ? "outbox_drained" : "email_not_configured" };
  },
};

function tournamentInput(c: Ctx) {
  const weights: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(c.form)) if (k.startsWith("w_")) weights[k.slice(2)] = value;
  return {
    name: c.form.name,
    game: c.form.game,
    format: c.form.format,
    participantType: c.form.participantType,
    teamSize: c.form.teamSize,
    maxParticipants: c.form.maxParticipants,
    checkInRequired: c.form.checkInRequired,
    region: c.form.region,
    regionLock: c.multi.regionLock?.join(",") ?? c.form.regionLock,
    startsAt: c.form.startsAt,
    timeZone: c.form.tz,
    description: c.form.description,
    rules: c.form.rules,
    bestOf: c.form.bestOf,
    submissionHours: c.form.submissionHours,
    weights,
    prizeText: c.form.prizeText,
    livestreamUrl: c.form.livestreamUrl,
    // Present only when the form rendered these fieldsets; otherwise the stored values are kept.
    settings:
      "formatSettings" in c.form
        ? {
            pointsWin: c.form.pointsWin,
            pointsDraw: c.form.pointsDraw,
            pointsLoss: c.form.pointsLoss,
            pointsBye: c.form.pointsBye,
            allowDraws: c.form.allowDraws,
            legs: c.form.legs,
            swissRounds: c.form.swissRounds,
            dqRule: c.form.dqRule,
            groupCount: c.form.groupCount,
            groupAdvance: c.form.groupAdvance,
            playoffFormat: c.form.playoffFormat,
            playoffSize: c.form.playoffSize,
            roundHours: c.form.roundHours,
            // Intermediate stages (MV-STAGES-2): stage2… to stage4… fields.
            ...Object.fromEntries(Object.entries(c.form).filter(([k]) => /^stage[2-4](Format|Size|Rounds|GroupCount|GroupAdvance|Legs)$/.test(k))),
            lobbySize: c.form.lobbySize,
            ffaGames: c.form.ffaGames,
            ffaAdvance: c.form.ffaAdvance,
            ffaPoints: c.form.ffaPoints,
            killPoints: c.form.killPoints,
          }
        : undefined,
    registration:
      "registrationFields" in c.form
        ? {
            approvalRequired: c.form.approvalRequired,
            registrationClosesAt: c.form.registrationClosesAt,
            rosterLocksAt: c.form.rosterLocksAt,
            noShowMinutes: c.form.noShowMinutes,
            fields: Object.fromEntries(Object.entries(c.form).filter(([k]) => /^field[1-5](Label|Type|Options|Required)$/.test(k))),
          }
        : undefined,
    circuit:
      "circuitFields" in c.form
        ? { circuitId: c.form.circuitId, circuitDivision: c.form.circuitDivision, circuitWeight: c.form.circuitWeight, qualifierCircuitId: c.form.qualifierCircuitId }
        : undefined,
    series: "seriesFields" in c.form ? Object.fromEntries(Object.entries(c.form).filter(([k]) => k.startsWith("series") && k !== "seriesFields")) : undefined,
    admission:
      "admissionFields" in c.form
        ? { emailVerified: c.form.admissionEmail, minAccountDays: c.form.admissionDays, minXp: c.form.admissionXp, minMatches: c.form.admissionMatches }
        : undefined,
    matchMinutes: "admissionFields" in c.form ? c.form.matchMinutes : undefined,
    mapPool: "seriesFields" in c.form ? c.form.mapPool : undefined,
  };
}

function circuitInput(c: Ctx) {
  return {
    name: c.form.name,
    season: c.form.season,
    game: c.form.game,
    participantType: c.form.participantType,
    description: c.form.description,
    pointsTable: c.form.pointsTable,
    participationPoints: c.form.participationPoints,
    qualifyTop: c.form.qualifyTop,
    divisions: c.form.divisions,
    promote: c.form.promote,
    relegate: c.form.relegate,
  };
}

function scoreInput(c: Ctx) {
  return {
    kills: c.form.kills,
    assists: c.form.assists,
    deaths: c.form.deaths,
    headshots: c.form.headshots,
    damage: c.form.damage,
    distance: c.form.distance,
    placement: c.form.placement,
    matchRef: c.form.matchRef,
    evidenceUrl: c.form.evidence,
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
    console.error(`[action ${action}] context`, (error as Error).message);
    return redirect(withParam(`/${fallbackLang}`, "e", errorCode(error)));
  }
  if (mailConfigured()) after(() => drainOutbox(c.db, 10).catch((e) => console.error("[outbox]", (e as Error).message)));
  // Webhooks: new audit entries become deliveries, and due deliveries are sent, after the response.
  after(() => partner.pumpWebhooks(c.db).catch((e) => console.error("[webhooks]", (e as Error).message)));
  try {
    // A suspension sanction keeps the account signed in to read and appeal; every other action stops here.
    if (c.user?.restricted && !RESTRICTED_OK.has(action)) fail("account_restricted");
    // Maintenance and feature switches (MV-STAFF-1): refused before anything changes; staff keep working.
    await system.gate(c.db, action, c.user);
    const result = await handler(c);
    const r = typeof result === "string" ? { to: result } : result ?? {};
    if (r.external) return redirect(r.to!, r.cookie);
    const to = r.to ?? c.back;
    return redirect(r.ok ? withParam(to, "ok", r.ok) : to, r.cookie);
  } catch (error) {
    const code = errorCode(error);
    if (code === "server_error" || code === "db_unavailable") console.error(`[action ${action}]`, error);
    if (code === "unauthorized") return redirect(`/${c.lang}/signin?next=${encodeURIComponent(c.back)}&e=unauthorized`);
    if (code === "mfa_not_enrolled") return redirect(withParam(`/${c.lang}/admin/security`, "e", code));
    if (code === "mfa_required" || code === "step_up_required")
      return redirect(`/${c.lang}/admin/mfa?next=${encodeURIComponent(c.back)}&e=${code}`);
    if (action === "auth.signup") return redirect(withParam(c.back, "e", code), draftCookie(signupDraft(c)));
    return redirect(withParam(c.back, "e", code));
  }
}
