/**
 * Tournament templates of an organising space. A template stores what the organiser set up in a tournament
 * (the same set a copy carries) under a name and a category; a draft created from it starts with those
 * settings. Statistics are counted from the tournaments actually created from the template.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canManageOrg } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { copyStart, draftSourceOf, insertDraft, type DraftSource, type TournamentRow } from "./tournaments.ts";
import * as v from "./validate.ts";

type Payload = Omit<DraftSource, "org_id">;

export async function saveTemplate(db: Database, user: SessionUser, tournamentId: string, input: { name?: unknown; category?: unknown }) {
  const name = v.displayName(input.name, 80);
  const category = v.oneLine(input.category, 40);
  return db.tx(async (q) => {
    const [src] = await q.query<TournamentRow & { region: string; description: string; rules: string; prize_text: string; livestream_url: string }>(
      "select * from tournaments where id = $1",
      [tournamentId],
    );
    if (!src) fail("not_found");
    if (!(await canManageOrg(q, src.org_id, user))) fail("forbidden");
    const { org_id: _org, ...payload } = draftSourceOf(src);
    let id: string;
    try {
      const [row] = await q.query<{ id: string }>(
        "insert into tournament_templates (org_id, name, category, payload, source_tournament_id, created_by) values ($1, $2, $3, $4, $5, $6) returning id",
        [src.org_id, name, category, JSON.stringify(payload), src.id, user.id],
      );
      id = row.id;
    } catch (error) {
      if (isUniqueViolation(error)) fail("template_exists");
      throw error;
    }
    await audit(q, { actorId: user.id, action: "template.created", entity: "org", entityId: src.org_id, data: { templateId: id, name, category, source: src.id } });
    return { id, orgId: src.org_id };
  });
}

/** Creates a draft tournament from a template. */
export async function createFromTemplate(db: Database, user: SessionUser, templateId: string, input: { name?: unknown; startsAt?: unknown; timeZone?: unknown }) {
  return db.tx(async (q) => {
    const [tpl] = await q.query<{ id: string; org_id: string; name: string; payload: Payload }>(
      "select id, org_id, name, payload from tournament_templates where id = $1 for update",
      [templateId],
    );
    if (!tpl) fail("not_found");
    if (!(await canManageOrg(q, tpl.org_id, user))) fail("forbidden");
    const name = v.displayName(String(input.name ?? "").trim() || tpl.payload.name || tpl.name, 80);
    const t = await insertDraft(q, user, { ...tpl.payload, org_id: tpl.org_id }, name, copyStart(input, null), tpl.id);
    await q.query("update tournament_templates set uses = uses + 1 where id = $1", [tpl.id]);
    await audit(q, { actorId: user.id, action: "tournament.created", entity: "tournament", entityId: t.id, data: { name, game: tpl.payload.game, format: tpl.payload.format, template: tpl.id } });
    return t;
  });
}

export async function deleteTemplate(db: Database, user: SessionUser, templateId: string) {
  await db.tx(async (q) => {
    const [tpl] = await q.query<{ id: string; org_id: string; name: string }>("select id, org_id, name from tournament_templates where id = $1 for update", [templateId]);
    if (!tpl) fail("not_found");
    if (!(await canManageOrg(q, tpl.org_id, user))) fail("forbidden");
    await q.query("delete from tournament_templates where id = $1", [tpl.id]);
    await audit(q, { actorId: user.id, action: "template.deleted", entity: "org", entityId: tpl.org_id, data: { templateId: tpl.id, name: tpl.name } });
  });
}

export type TemplateSummary = {
  id: string;
  name: string;
  category: string;
  game: string;
  format: string;
  created_at: Date;
  /** Drafts created from the template, and how many of them were completed. */
  created: number;
  completed: number;
  /** Average entrants (registered at the end, disqualified included) of completed tournaments; null without any. */
  avg_entrants: number | null;
};

/** Templates of a space, by category and name, with statistics from real tournaments only. */
export async function listTemplates(q: Queryable, orgId: string) {
  return q.query<TemplateSummary>(
    `select tt.id, tt.name, tt.category, tt.payload->>'game' as game, tt.payload->>'format' as format, tt.created_at,
            (select count(*)::int from tournaments t where t.template_id = tt.id) as created,
            (select count(*)::int from tournaments t where t.template_id = tt.id and t.status in ('COMPLETED','ARCHIVED')) as completed,
            (select round(avg((select count(*) from registrations r where r.tournament_id = t.id and r.status in ('registered','disqualified'))))::int
               from tournaments t where t.template_id = tt.id and t.status in ('COMPLETED','ARCHIVED')) as avg_entrants
       from tournament_templates tt where tt.org_id = $1
      order by tt.category asc, lower(tt.name) asc`,
    [orgId],
  );
}
