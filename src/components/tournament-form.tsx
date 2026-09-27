import { dict, type Locale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { DEFAULT_WEIGHTS, mergeWeights, WEIGHT_KEYS } from "@/server/scoring.ts";
import { ActionForm, Check, Field } from "./ui";
import { LocalDateTimeInput, TimeZoneField } from "./time";

export type TournamentDefaults = {
  id?: string;
  name?: string;
  game?: string;
  format?: string;
  participant_type?: string;
  team_size?: number;
  max_participants?: number;
  check_in_required?: boolean;
  region?: string;
  region_lock?: string[];
  starts_at?: Date | string;
  description?: string;
  rules?: string;
  best_of?: number | null;
  submission_hours?: number | null;
  scoring?: Record<string, number> | null;
  prize_text?: string;
  livestream_url?: string;
};

const WEIGHT_NAMES: Record<string, { ru: string; en: string }> = {
  kills: { ru: "Очки за убийство", en: "Points per kill" },
  assists: { ru: "За помощь", en: "Per assist" },
  headshots: { ru: "За убийство в голову", en: "Per headshot kill" },
  damage: { ru: "За единицу урона", en: "Per damage point" },
  distance: { ru: "За метр пути", en: "Per metre travelled" },
  place1: { ru: "За 1-е место", en: "For 1st place" },
  place2: { ru: "За 2-е место", en: "For 2nd place" },
  place3: { ru: "За 3-е место", en: "For 3rd place" },
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
  const ru = lang === "ru";
  const editing = Boolean(t?.id);
  const weights = mergeWeights(t?.scoring ?? null);
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
        <Field label={ru ? "Формат" : "Format"} hint={ru ? "Сетки — для дуэльных игр; leaderboard — для королевских битв и любых игр со статистикой." : "Brackets suit duel games; leaderboards suit battle royales and any game with stats."}>
          <select name="format" defaultValue={t?.format ?? "single_elimination"}>
            <option value="single_elimination">{ru ? "Олимпийская система" : "Single elimination"}</option>
            <option value="double_elimination">{ru ? "Двойное выбывание (с перезапуском финала)" : "Double elimination (with bracket reset)"}</option>
            <option value="leaderboard">{ru ? "Leaderboard по очкам" : "Points leaderboard"}</option>
          </select>
        </Field>
        <Field label={o.game} hint={ru ? "Игры без сетки доступны только в формате leaderboard." : "Games without brackets are available in the leaderboard format only."}>
          <select name="game" required defaultValue={t?.game ?? "cs2"}>
            {GAMES.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
                {g.bracket ? "" : ru ? " — только leaderboard" : " — leaderboard only"}
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
        <Field label={ru ? "Только для стран (ISO-коды)" : "Countries only (ISO codes)"} hint={ru ? "Например: AE, SA, QA. Пусто — без ограничений. Проверяется страна в профиле игрока." : "For example: AE, SA, QA. Empty means no restriction. The player's profile country is checked."}>
          <input name="regionLock" maxLength={400} defaultValue={t?.region_lock?.join(", ") ?? ""} placeholder="AE, SA" autoCapitalize="characters" />
        </Field>
      </div>
      {structuralLocked ? <p className="small muted">{o.editNote}</p> : null}
      <Check name="checkInRequired" label={o.checkIn} defaultChecked={t?.check_in_required ?? true} />

      <fieldset className="fieldset">
        <legend>{ru ? "Настройки leaderboard" : "Leaderboard settings"}</legend>
        <p className="small muted">{ru ? "Используются только в формате leaderboard. Веса фиксируются при старте." : "Used only in the leaderboard format. Weights lock when the tournament starts."}</p>
        <div className="form-grid">
          <Field label={ru ? "Учитывать лучшие N результатов" : "Count best N results"} hint={d.common.optional}>
            <input name="bestOf" type="number" min={1} max={50} defaultValue={t?.best_of ?? ""} />
          </Field>
          <Field label={ru ? "Окно отправки, часов" : "Submission window, hours"} hint={ru ? "Отсчёт со старта. Пусто — без срока." : "Counted from the start. Empty means no deadline."}>
            <input name="submissionHours" type="number" min={1} max={720} defaultValue={t?.submission_hours ?? ""} />
          </Field>
        </div>
        <div className="form-grid form-grid-4">
          {WEIGHT_KEYS.map((k) => (
            <Field key={k} label={WEIGHT_NAMES[k][lang]} hint={`${ru ? "по умолчанию" : "default"} ${DEFAULT_WEIGHTS[k]}`}>
              <input name={`w_${k}`} type="number" min={0} max={1000} step="any" defaultValue={weights[k]} inputMode="decimal" />
            </Field>
          ))}
        </div>
      </fieldset>

      <Field label={o.tDescription} hint={d.common.optional}>
        <textarea name="description" rows={4} maxLength={4000} defaultValue={t?.description} />
      </Field>
      <Field label={o.rules} hint={d.common.optional}>
        <textarea name="rules" rows={6} maxLength={8000} defaultValue={t?.rules} />
      </Field>
      <Field
        label={ru ? "Призы от организатора" : "Organiser's prizes"}
        hint={ru ? "Только реальные, подтверждённые призы партнёров. Призовые фонды из взносов участников запрещены." : "Only real, confirmed partner prizes. Prize pools funded by participant fees are prohibited."}
      >
        <textarea name="prizeText" rows={2} maxLength={600} defaultValue={t?.prize_text} />
      </Field>
      <Field label={ru ? "Ссылка на трансляцию" : "Livestream link"} hint={d.common.optional}>
        <input name="livestreamUrl" type="url" maxLength={500} placeholder="https://" defaultValue={t?.livestream_url} />
      </Field>
      <button className="btn btn-primary">{editing ? d.common.save : o.createTournament}</button>
    </ActionForm>
  );
}
