import { dict, type Locale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { DEFAULT_WEIGHTS, mergeWeights, WEIGHT_KEYS } from "@/server/scoring.ts";
import { editableSettings, RR_MAX_ENTRANTS, SWISS_MAX_ROUNDS } from "@/server/format-settings.ts";
import { DEFAULT_POINTS } from "@/server/standings.ts";
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
  format_settings?: unknown;
  circuit_id?: string | null;
  circuit_division?: number | null;
  circuit_weight?: number;
  qualifier_circuit_id?: string | null;
};

/** A circuit of the organising space, offered for linking. */
export type CircuitOption = { id: string; name: string; season: string; game: string; participant_type: string; divisions: number; status: string; qualify_top: number };

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
  circuits = [],
}: {
  lang: Locale;
  back: string;
  orgId?: string;
  t?: TournamentDefaults;
  structuralLocked?: boolean;
  circuits?: CircuitOption[];
}) {
  const d = dict(lang);
  const o = d.organizer;
  const ru = lang === "ru";
  const editing = Boolean(t?.id);
  const weights = mergeWeights(t?.scoring ?? null);
  // Round-robin and Swiss settings as the organiser entered them (never the values frozen at a start).
  const rs =
    t?.format === "round_robin" || t?.format === "swiss" ? editableSettings({ format: t.format, format_settings: t.format_settings }) : null;
  const points = rs?.points ?? DEFAULT_POINTS;
  const activeCircuits = circuits.filter((c) => c.status === "active");
  const qualifiers = circuits.filter((c) => c.qualify_top > 0);
  const circuitLabel = (c: CircuitOption) => `${c.name} · ${c.season} · ${c.game} · ${c.participant_type === "team" ? o.team : o.solo}`;
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
        <Field
          label={ru ? "Формат" : "Format"}
          hint={
            ru
              ? "Сетки, круговая и швейцарская системы — для игр с матчами «сторона против стороны»; leaderboard — для королевских битв и любых игр со статистикой."
              : "Brackets, round robin and Swiss suit head-to-head games; leaderboards suit battle royales and any game with stats."
          }
        >
          <select name="format" defaultValue={t?.format ?? "single_elimination"}>
            <option value="single_elimination">{ru ? "Олимпийская система" : "Single elimination"}</option>
            <option value="double_elimination">{ru ? "Двойное выбывание (с перезапуском финала)" : "Double elimination (with bracket reset)"}</option>
            <option value="round_robin">{ru ? `Круговая система — каждый с каждым (до ${RR_MAX_ENTRANTS})` : `Round robin — everyone plays everyone (up to ${RR_MAX_ENTRANTS})`}</option>
            <option value="swiss">{ru ? "Швейцарская система — пары по очкам" : "Swiss system — pairings by points"}</option>
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
        <legend>{ru ? "Круговая и швейцарская системы" : "Round robin and Swiss"}</legend>
        <input type="hidden" name="formatSettings" value="1" />
        <p className="small muted">
          {ru
            ? "Используются только в этих форматах и фиксируются при старте. Очки — целые числа 0–100: победа больше поражения, ничья между ними."
            : "Used only in these formats and frozen at the start. Points are whole numbers 0–100: a win above a loss, a draw between them."}
        </p>
        <div className="form-grid form-grid-4">
          <Field label={ru ? "Очки за победу" : "Points for a win"}>
            <input name="pointsWin" type="number" min={0} max={100} defaultValue={points.win} inputMode="numeric" />
          </Field>
          <Field label={ru ? "За ничью" : "For a draw"}>
            <input name="pointsDraw" type="number" min={0} max={100} defaultValue={points.draw} inputMode="numeric" />
          </Field>
          <Field label={ru ? "За поражение" : "For a loss"}>
            <input name="pointsLoss" type="number" min={0} max={100} defaultValue={points.loss} inputMode="numeric" />
          </Field>
          <Field label={ru ? "За bye (швейцарская)" : "For a bye (Swiss)"} hint={ru ? "Пусто — как за победу" : "Empty = same as a win"}>
            <input name="pointsBye" type="number" min={0} max={100} defaultValue={t?.format === "swiss" ? points.bye : ""} inputMode="numeric" />
          </Field>
          <Field label={ru ? "Круги (круговая)" : "Legs (round robin)"}>
            <select name="legs" defaultValue={String(rs?.legs ?? 1)}>
              <option value="1">{ru ? "Один" : "One"}</option>
              <option value="2">{ru ? "Два — дома и в гостях" : "Two — home and away"}</option>
            </select>
          </Field>
          <Field label={ru ? "Дисквалификация (круговая)" : "Disqualification (round robin)"} hint={ru ? "Что происходит с результатами участника" : "What happens to the entrant's results"}>
            <select name="dqRule" defaultValue={rs?.disqualification ?? "annul"}>
              <option value="annul">{ru ? "Аннулировать все его матчи" : "Annul all of their matches"}</option>
              <option value="forfeit">{ru ? "Оставшиеся матчи — соперникам" : "Remaining matches to opponents"}</option>
              <option value="half">{ru ? "Правило 50%: аннулировать, если сыграно меньше половины" : "50% rule: annul if under half was played"}</option>
            </select>
          </Field>
          <Field label={ru ? "Туров (швейцарская)" : "Rounds (Swiss)"} hint={ru ? `Пусто — автоматически; не больше ${SWISS_MAX_ROUNDS} и N − 1` : `Empty = automatic; at most ${SWISS_MAX_ROUNDS} and N − 1`}>
            <input name="swissRounds" type="number" min={1} max={SWISS_MAX_ROUNDS} defaultValue={rs?.rounds ?? ""} inputMode="numeric" />
          </Field>
        </div>
        <Check name="allowDraws" label={ru ? "Допускать ничьи (равный счёт)" : "Allow draws (equal score)"} defaultChecked={rs?.allowDraws ?? false} />
      </fieldset>

      {circuits.length ? (
        <fieldset className="fieldset">
          <legend>{ru ? "Серия и отбор" : "Circuit and qualification"}</legend>
          <input type="hidden" name="circuitFields" value="1" />
          <p className="small muted">
            {ru
              ? "Места турнира приносят очки в серию: вес 100 — ×1,0, 200 — ×2,0. Отбор пускает только квалифицированных по таблице серии. После первой регистрации связь не меняется."
              : "The tournament's places earn circuit points: weight 100 is ×1.0, 200 is ×2.0. Qualification admits only entrants qualified by the circuit table. The link is frozen after the first registration."}
          </p>
          <div className="form-grid">
            <Field label={ru ? "Серия (очки)" : "Circuit (points)"}>
              <select name="circuitId" defaultValue={t?.circuit_id ?? ""}>
                <option value="">—</option>
                {activeCircuits.map((c) => (
                  <option key={c.id} value={c.id}>
                    {circuitLabel(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={ru ? "Дивизион" : "Division"} hint={ru ? "Для серий с дивизионами" : "For circuits with divisions"}>
              <select name="circuitDivision" defaultValue={t?.circuit_division ? String(t.circuit_division) : ""}>
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={ru ? "Вес турнира" : "Event weight"} hint="10–1000">
              <input name="circuitWeight" type="number" min={10} max={1000} defaultValue={t?.circuit_weight ?? 100} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Только квалифицированные из" : "Only qualified from"}>
              <select name="qualifierCircuitId" defaultValue={t?.qualifier_circuit_id ?? ""}>
                <option value="">—</option>
                {qualifiers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {circuitLabel(c)} · {ru ? "топ" : "top"} {c.qualify_top}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </fieldset>
      ) : null}

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
