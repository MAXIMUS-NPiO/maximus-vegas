import { dict, type Locale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { ActionForm, Check, Field } from "./ui";
import { LocalDateTimeInput, TimeZoneField } from "./time";

export type TournamentDefaults = {
  id?: string;
  name?: string;
  game?: string;
  participant_type?: string;
  team_size?: number;
  max_participants?: number;
  check_in_required?: boolean;
  region?: string;
  starts_at?: Date | string;
  description?: string;
  rules?: string;
};

export function TournamentForm({
  lang,
  back,
  orgId,
  t,
  structuralLocked,
}: {
  lang: Locale;
  back: string;
  orgId?: string;
  t?: TournamentDefaults;
  structuralLocked?: boolean;
}) {
  const d = dict(lang);
  const o = d.organizer;
  const editing = Boolean(t?.id);
  return (
    <ActionForm
      action={editing ? "tournament.update" : "tournament.create"}
      lang={lang}
      back={back}
      hidden={editing ? { tournament: t!.id! } : { org: orgId! }}
      className="card form-card"
    >
      <TimeZoneField />
      <Field label={o.tName}>
        <input name="name" required minLength={2} maxLength={80} defaultValue={t?.name} />
      </Field>
      <div className="form-grid">
        <Field label={o.game} hint={o.gameNote}>
          <select name="game" required defaultValue={t?.game ?? "cs2"}>
            {GAMES.filter((g) => g.bracket).map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={o.participantType}>
          <select name="participantType" defaultValue={t?.participant_type ?? "team"}>
            <option value="team">{o.team}</option>
            <option value="solo">{o.solo}</option>
          </select>
        </Field>
        <Field label={o.teamSize} hint={o.teamSizeNote}>
          <input name="teamSize" type="number" min={2} max={10} defaultValue={t?.team_size && t.team_size > 1 ? t.team_size : 5} />
        </Field>
        <Field label={o.maxParticipants}>
          <input name="maxParticipants" type="number" min={2} max={512} required defaultValue={t?.max_participants ?? 16} />
        </Field>
        <Field label={o.startsAt}>
          <LocalDateTimeInput name="startsAt" iso={t?.starts_at ? new Date(t.starts_at).toISOString() : null} required />
        </Field>
        <Field label={o.region} hint={d.common.optional}>
          <input name="region" maxLength={60} defaultValue={t?.region} />
        </Field>
      </div>
      {structuralLocked ? <p className="small muted">{o.editNote}</p> : null}
      <Check name="checkInRequired" label={o.checkIn} defaultChecked={t?.check_in_required ?? true} />
      <Field label={o.tDescription} hint={d.common.optional}>
        <textarea name="description" rows={4} maxLength={4000} defaultValue={t?.description} />
      </Field>
      <Field label={o.rules} hint={d.common.optional}>
        <textarea name="rules" rows={6} maxLength={8000} defaultValue={t?.rules} />
      </Field>
      <button className="btn btn-primary">{editing ? d.common.save : o.createTournament}</button>
    </ActionForm>
  );
}
