import { TournamentGameFields } from "./tournament-game-fields";
import { dict, type Locale } from "@/lib/i18n.ts";
import { publicGames } from "@/server/catalog.ts";
import { viewer } from "@/server/viewer.ts";
import { DEFAULT_WEIGHTS, mergeWeights, WEIGHT_KEYS } from "@/server/scoring.ts";
import {
  CHAIN_SIZE_MAX,
  editableSettings,
  GAUNTLET_MAX,
  isRoundFormat,
  MAX_GROUPS,
  PLAYOFF_MAX,
  ROUND_HOURS_MAX,
  RR_MAX_ENTRANTS,
  SWISS_MAX_ROUNDS,
} from "@/server/format-settings.ts";
import { DEFAULT_POINTS } from "@/server/standings.ts";
import { FFA_MAX_GAMES, FFA_MAX_LOBBY, ffaSettingsOf, pointsText } from "@/server/ffa.ts";
import { fieldsOf, MAX_FIELDS, type RegField } from "@/server/registration.ts";
import { SERIES_LENGTHS, SERIES_MAX_ROUND, SERIES_ROWS, seriesRulesOf } from "@/server/series.ts";
import { groupName } from "@/server/stages.ts";
import { admissionOf } from "@/server/admission.ts";
import { mailConfigured } from "@/server/mail.ts";
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
  eligible_game_limit?: number;
  submission_hours?: number | null;
  scoring?: Record<string, number> | null;
  prize_text?: string;
  livestream_url?: string;
  format_settings?: unknown;
  circuit_id?: string | null;
  circuit_division?: number | null;
  circuit_weight?: number;
  qualifier_circuit_id?: string | null;
  registration_fields?: RegField[] | null;
  approval_required?: boolean;
  registration_closes_at?: Date | string | null;
  roster_locks_at?: Date | string | null;
  no_show_minutes?: number | null;
  series_rules?: unknown;
  map_pool?: unknown;
  admission?: unknown;
  match_minutes?: number | null;
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

export async function TournamentForm({
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
  const {db}=await viewer();
  const games=(await publicGames(db,true)).filter(g=>!g.retired || g.slug===t?.game);
  const d = dict(lang);
  const o = d.organizer;
  const ru = lang === "ru";
  const editing = Boolean(t?.id);
  const weights = mergeWeights(t?.scoring ?? null);
  // Round-robin and Swiss settings as the organiser entered them (never the values frozen at a start).
  const rs = t?.format && isRoundFormat(t.format) ? editableSettings({ format: t.format, format_settings: t.format_settings }) : null;
  // Intermediate round stages between the main stage and the playoff (MV-STAGES-2): stage k is chain[k − 2].
  const stageFields = (k: number) => {
    const c = rs?.chain?.[k - 2] ?? null;
    return (
      <div className="form-grid form-grid-4">
        <Field label={ru ? `Этап ${k}` : `Stage ${k}`}>
          <select name={`stage${k}Format`} defaultValue={c?.format ?? "none"}>
            <option value="none">{ru ? "Нет" : "None"}</option>
            <option value="swiss">{ru ? "Швейцарская система" : "Swiss system"}</option>
            <option value="round_robin">{ru ? "Круговая система" : "Round robin"}</option>
            <option value="groups">{ru ? "Группы" : "Groups"}</option>
          </select>
        </Field>
        <Field
          label={ru ? `Участников этапа ${k}` : `Stage ${k} entrants`}
          hint={ru ? `Лучшие N предыдущего этапа, 2–${CHAIN_SIZE_MAX}; после групп — все выходящие` : `The top N of the stage before, 2–${CHAIN_SIZE_MAX}; after groups, all who advance`}
        >
          <input name={`stage${k}Size`} type="number" min={2} max={CHAIN_SIZE_MAX} defaultValue={c?.size ?? 8} inputMode="numeric" />
        </Field>
        <Field label={ru ? "Туров (швейцарская)" : "Rounds (Swiss)"} hint={ru ? "Пусто — автоматически" : "Empty = automatic"}>
          <input name={`stage${k}Rounds`} type="number" min={1} max={SWISS_MAX_ROUNDS} defaultValue={c?.rounds ?? ""} inputMode="numeric" />
        </Field>
        <Field label={ru ? "Круги (круговая, группы)" : "Legs (round robin, groups)"}>
          <select name={`stage${k}Legs`} defaultValue={String(c?.legs ?? 1)}>
            <option value="1">{ru ? "Один" : "One"}</option>
            <option value="2">{ru ? "Два — дома и в гостях" : "Two — home and away"}</option>
          </select>
        </Field>
        <Field label={ru ? "Групп" : "Groups"} hint={`2–${MAX_GROUPS}`}>
          <input name={`stage${k}GroupCount`} type="number" min={2} max={MAX_GROUPS} defaultValue={c?.groups?.count ?? 2} inputMode="numeric" />
        </Field>
        <Field label={ru ? "Выходят из группы" : "Advance per group"} hint="1–16">
          <input name={`stage${k}GroupAdvance`} type="number" min={1} max={16} defaultValue={c?.groups?.advance ?? 2} inputMode="numeric" />
        </Field>
      </div>
    );
  };
  const points = rs?.points ?? DEFAULT_POINTS;
  const ffa = ffaSettingsOf({ format_settings: t?.format === "ffa" ? t.format_settings : null });
  const fields = fieldsOf({ registration_fields: t?.registration_fields ?? null });
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
  const activeCircuits = circuits.filter((c) => c.status === "active");
  const qualifiers = circuits.filter((c) => c.qualify_top > 0);
  const circuitLabel = (c: CircuitOption) => `${c.name} · ${c.season} · ${c.game} · ${c.participant_type === "team" ? o.team : o.solo}`;
  const series = seriesRulesOf({ series_rules: t?.series_rules ?? null });
  const admission = admissionOf({ admission: t?.admission ?? null });
  const lengthOptions = (inherit: boolean) => (
    <>
      {inherit ? <option value="">{ru ? "Как выше" : "As above"}</option> : null}
      {SERIES_LENGTHS.map((n) => (
        <option key={n} value={String(n)}>
          {n === 1 ? (ru ? "Bo1 — одна игра" : "Bo1 — one game") : ru ? `Bo${n} — до ${(n + 1) / 2} побед` : `Bo${n} — first to ${(n + 1) / 2}`}
        </option>
      ))}
    </>
  );
  const pointCell = (name: string, label: string, value: number | undefined) => (
    <Field label={label}>
      <input name={name} type="number" min={0} max={100} defaultValue={value ?? ""} inputMode="numeric" />
    </Field>
  );
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
        <TournamentGameFields lang={lang} games={games.map(({slug,name,formats})=>({slug,name,formats}))} initialGame={t?.game} initialFormat={t?.format} editing={editing}/>
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
        <legend>{ru ? "Круговая, швейцарская системы и группы" : "Round robin, Swiss and groups"}</legend>
        <input type="hidden" name="formatSettings" value="1" />
        <p className="small muted">
          {ru
            ? "Используются только в этих форматах и фиксируются при старте. Очки — целые числа 0–100: победа больше поражения, ничья между ними."
            : "Used only in these formats and frozen at the start. Points are whole numbers 0–100: a win above a loss, a draw between them."}
        </p>
        <div className="fieldset-body">
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
            <Field label={ru ? "Круги (круговая, группы)" : "Legs (round robin, groups)"}>
              <select name="legs" defaultValue={String(rs?.legs ?? 1)}>
                <option value="1">{ru ? "Один" : "One"}</option>
                <option value="2">{ru ? "Два — дома и в гостях" : "Two — home and away"}</option>
              </select>
            </Field>
            <Field label={ru ? "Дисквалификация (круговая, группы)" : "Disqualification (round robin, groups)"} hint={ru ? "Что происходит с результатами участника" : "What happens to the entrant's results"}>
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
        </div>
        <Check name="allowDraws" label={ru ? "Допускать ничьи (равный счёт)" : "Allow draws (equal score)"} defaultChecked={rs?.allowDraws ?? false} />
      </fieldset>

      <fieldset className="fieldset">
        <legend>{ru ? "Этапы: группы, промежуточный этап, плей-офф, расписание туров" : "Stages: groups, intermediate stage, playoff, round schedule"}</legend>
        <p className="small muted">
          {ru
            ? "Для групп, круговой и швейцарской систем. Группы составляются змейкой по посеву; в группе — круговая система с очками выше. Плей-офф для групп обязателен (по умолчанию — олимпийская система), его размер — групп × выходящих; для круговой и швейцарской он необязателен. Всё фиксируется при старте."
            : "For groups, round robin and Swiss. Groups are dealt in a snake by seed; each group is a round robin with the points above. Groups always end in a playoff (single elimination by default) of groups × advancing entrants; for round robin and Swiss it is optional. Everything is frozen at the start."}
        </p>
        <div className="fieldset-body stack">
          <div className="form-grid form-grid-4">
            <Field label={ru ? "Групп" : "Groups"} hint={`2–${MAX_GROUPS}`}>
              <input name="groupCount" type="number" min={2} max={MAX_GROUPS} defaultValue={rs?.groups?.count ?? 4} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Выходят из группы" : "Advance per group"} hint="1–16">
              <input name="groupAdvance" type="number" min={1} max={16} defaultValue={rs?.groups?.advance ?? 2} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Плей-офф" : "Playoff"}>
              <select name="playoffFormat" defaultValue={rs?.playoff?.format ?? "none"}>
                <option value="none">{ru ? "Без плей-офф" : "No playoff"}</option>
                <option value="single_elimination">{ru ? "Олимпийская система" : "Single elimination"}</option>
                <option value="double_elimination">{ru ? "Двойное выбывание" : "Double elimination"}</option>
                <option value="gauntlet">{ru ? `Лесенка (до ${GAUNTLET_MAX})` : `Gauntlet (up to ${GAUNTLET_MAX})`}</option>
              </select>
            </Field>
            <Field label={ru ? "Участников плей-офф" : "Playoff entrants"} hint={ru ? `Круговая и швейцарская: лучшие N по таблице, 2–${PLAYOFF_MAX}` : `Round robin and Swiss: the top N of the table, 2–${PLAYOFF_MAX}`}>
              <input name="playoffSize" type="number" min={2} max={PLAYOFF_MAX} defaultValue={rs?.playoff?.size ?? 8} inputMode="numeric" />
            </Field>
            <Field
              label={ru ? "Интервал между турами и раундами, часов" : "Hours between rounds"}
              hint={ru ? `0 — тур 1 в момент старта, остальные по договорённости; до ${ROUND_HOURS_MAX}` : `0 = round 1 at the start, later rounds by arrangement; up to ${ROUND_HOURS_MAX}`}
            >
              <input name="roundHours" type="number" min={0} max={ROUND_HOURS_MAX} defaultValue={rs?.roundHours ?? 0} inputMode="numeric" />
            </Field>
          </div>
          <p className="small muted">
            {ru
              ? "Промежуточные этапы (необязательно) — этапы в турах между основным этапом и плей-офф, например: швейцарская система → группы → плей-офф. В каждый выходят лучшие N по таблице предыдущего этапа, после групп — все, кто выходит из групп. Плей-офф — из лучших последнего этапа; если это группы, размер плей-офф равен числу групп × выходящих. Очки, ничьи и правило дисквалификации общие для всех этапов."
              : "Intermediate stages (optional): stages in rounds between the main stage and the playoff, for example Swiss → groups → playoff. The top N of the previous stage's table go on to each; after groups, everyone who advances from the groups. The playoff takes the best of the last stage; if that is groups, the playoff size is groups × advancing entrants. Points, draws and the disqualification rule are shared by every stage."}
          </p>
          {stageFields(2)}
          <details className="disclosure" open={Boolean(rs?.chain && rs.chain.length > 1)}>
            <summary>{ru ? "Ещё этапы: 3 и 4" : "More stages: 3 and 4"}</summary>
            <div className="stack">
              {stageFields(3)}
              {stageFields(4)}
            </div>
          </details>
        </div>
      </fieldset>

      <fieldset className="fieldset">
        <legend>{ru ? "Формат серий и очки по уровням" : "Series format and points by level"}</legend>
        <input type="hidden" name="seriesFields" value="1" />
        <p className="small muted">
          {ru
            ? "Для матчей «сторона против стороны». Настройка наследуется: турнир → плей-офф → нижняя сетка → группа → тур или стадия → матч; более точная заменяет общую. В серии до N побед счёт — число выигранных игр (Bo3: 2:0 или 2:1). Всё фиксируется при старте; судья может изменить отдельный матч до первого результата. Правила MV-SERIES-1."
            : "For head-to-head matches. Settings are inherited: tournament → playoff → lower bracket → group → round or stage → match; the more specific one wins. In a series the score is games won (Bo3: 2:0 or 2:1). Everything is frozen at the start; a referee may change one match before its first result. Rules MV-SERIES-1."}
        </p>
        <div className="fieldset-body">
          <div className="form-grid form-grid-4">
            <Field label={ru ? "Серия по умолчанию" : "Default series"}>
              <select name="seriesBestOf" defaultValue={String(series.bestOf)}>
                {lengthOptions(false)}
              </select>
            </Field>
            <Field label={ru ? "Плей-офф" : "Playoff"} hint={ru ? "После групп, круговой, швейцарской" : "After groups, round robin, Swiss"}>
              <select name="seriesPlayoff" defaultValue={series.playoff ? String(series.playoff) : ""}>
                {lengthOptions(true)}
              </select>
            </Field>
            <Field label={ru ? "Полуфиналы" : "Semi-finals"} hint={ru ? "Двойное выбывание: финалы верхней и нижней сеток" : "Double elimination: upper and lower finals"}>
              <select name="seriesSemifinal" defaultValue={series.semifinal ? String(series.semifinal) : ""}>
                {lengthOptions(true)}
              </select>
            </Field>
            <Field label={ru ? "Финал" : "Final"} hint={ru ? "Двойное выбывание: гранд-финал" : "Double elimination: grand final"}>
              <select name="seriesFinal" defaultValue={series.final ? String(series.final) : ""}>
                {lengthOptions(true)}
              </select>
            </Field>
            <Field label={ru ? "Нижняя сетка" : "Lower bracket"} hint={ru ? "Двойное выбывание" : "Double elimination"}>
              <select name="seriesLower" defaultValue={series.lower ? String(series.lower) : ""}>
                {lengthOptions(true)}
              </select>
            </Field>
          </div>
        </div>
        <details className="disclosure" open={series.rounds.length + series.groups.length > 0}>
          <summary>{ru ? "Особые туры и группы" : "Specific rounds and groups"}</summary>
          <p className="small muted">
            {ru
              ? `Тур — номер тура основного этапа (круговая, швейцарская, группы), 1–${SERIES_MAX_ROUND}; группа — буква (A, B …). Пустая серия — как выше. Очки — все три или ни одного; bye — только швейцарская (пусто — как за победу).`
              : `A round is a main-stage round number (round robin, Swiss, groups), 1–${SERIES_MAX_ROUND}; a group is a letter (A, B …). An empty series means as above. Points: all three or none; bye is Swiss only (empty = as a win).`}
          </p>
          <div className="fieldset-body">
            {Array.from({ length: SERIES_ROWS }, (_, i) => {
              const r = series.rounds[i];
              const n = i + 1;
              return (
                <div key={`r${n}`} className="form-grid form-grid-6 field-row">
                  <Field label={ru ? `Тур (строка ${n})` : `Round (row ${n})`}>
                    <input name={`seriesRound${n}`} type="number" min={1} max={SERIES_MAX_ROUND} defaultValue={r?.round ?? ""} inputMode="numeric" />
                  </Field>
                  <Field label={ru ? "Серия" : "Series"}>
                    <select name={`seriesRound${n}BestOf`} defaultValue={r?.bestOf ? String(r.bestOf) : ""}>
                      {lengthOptions(true)}
                    </select>
                  </Field>
                  {pointCell(`seriesRound${n}Win`, ru ? "Победа" : "Win", r?.points?.win)}
                  {pointCell(`seriesRound${n}Draw`, ru ? "Ничья" : "Draw", r?.points?.draw)}
                  {pointCell(`seriesRound${n}Loss`, ru ? "Поражение" : "Loss", r?.points?.loss)}
                  {pointCell(`seriesRound${n}Bye`, "Bye", t?.format === "swiss" ? r?.points?.bye : undefined)}
                </div>
              );
            })}
            {Array.from({ length: SERIES_ROWS }, (_, i) => {
              const g = series.groups[i];
              const n = i + 1;
              return (
                <div key={`g${n}`} className="form-grid form-grid-6 field-row">
                  <Field label={ru ? `Группа (строка ${n})` : `Group (row ${n})`}>
                    <input name={`seriesGroup${n}`} maxLength={2} defaultValue={g ? groupName(g.group) : ""} autoCapitalize="characters" />
                  </Field>
                  <Field label={ru ? "Серия" : "Series"}>
                    <select name={`seriesGroup${n}BestOf`} defaultValue={g?.bestOf ? String(g.bestOf) : ""}>
                      {lengthOptions(true)}
                    </select>
                  </Field>
                  {pointCell(`seriesGroup${n}Win`, ru ? "Победа" : "Win", g?.points?.win)}
                  {pointCell(`seriesGroup${n}Draw`, ru ? "Ничья" : "Draw", g?.points?.draw)}
                  {pointCell(`seriesGroup${n}Loss`, ru ? "Поражение" : "Loss", g?.points?.loss)}
                </div>
              );
            })}
          </div>
        </details>
        <Field
          label={ru ? "Пул карт для вето" : "Map pool for the veto"}
          hint={
            ru
              ? "Через запятую или с новой строки, 2–15 карт; пусто — без вето. Сверьте с действующим пулом издателя. Ходы по длине серии: два первых бана, затем пики, затем оставшиеся баны, последняя карта — решающая; начинает верхний посев (MV-VETO-1). Пул фиксируется после первого хода вето."
              : "Separated by commas or new lines, 2–15 maps; empty means no veto. Check against the publisher's current pool. Turns by series length: two opening bans, then the picks, then the remaining bans; the last map is the decider; the higher seed starts (MV-VETO-1). The pool is frozen after the first veto turn."
          }
        >
          <textarea name="mapPool" rows={2} maxLength={600} defaultValue={Array.isArray(t?.map_pool) ? (t!.map_pool as string[]).join(", ") : ""} />
        </Field>
      </fieldset>

      <fieldset className="fieldset">
        <legend>{ru ? "FFA: лобби и очки" : "FFA: lobbies and points"}</legend>
        <p className="small muted">
          {ru
            ? "Только для формата FFA. Участники делятся на лобби змейкой по посеву; каждое лобби играет заданное число игр. Очки игры = очки за место + убийства × очки за убийство. Из каждого лобби в следующий раунд выходят лучшие; раунд с одним лобби — финал. Правила MV-FFA-1."
            : "FFA only. Entrants are dealt into lobbies in a snake by seed; each lobby plays the set number of games. Game points = placement points + kills × points per kill. The best of each lobby advance; a round with one lobby is the final. Rules MV-FFA-1."}
        </p>
        <div className="fieldset-body">
          <div className="form-grid form-grid-4">
            <Field label={ru ? "Участников в лобби" : "Lobby size"} hint={`2–${FFA_MAX_LOBBY}`}>
              <input name="lobbySize" type="number" min={2} max={FFA_MAX_LOBBY} defaultValue={ffa.lobbySize} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Игр в раунде" : "Games per round"} hint={`1–${FFA_MAX_GAMES}`}>
              <input name="ffaGames" type="number" min={1} max={FFA_MAX_GAMES} defaultValue={ffa.games} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Выходят из лобби" : "Advance per lobby"} hint={ru ? "При нескольких лобби" : "With several lobbies"}>
              <input name="ffaAdvance" type="number" min={1} max={FFA_MAX_LOBBY - 1} defaultValue={ffa.advance} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Очки за убийство" : "Points per kill"} hint="0–10">
              <input name="killPoints" type="number" min={0} max={10} defaultValue={ffa.killPoints} inputMode="numeric" />
            </Field>
          </div>
        </div>
        <Field label={ru ? "Очки за места 1, 2, 3 …" : "Points for places 1, 2, 3 …"} hint={ru ? "Через запятую, без роста к нижним местам; места ниже таблицы — 0" : "Comma-separated, never rising for lower places; places below the table score 0"}>
          <input name="ffaPoints" maxLength={400} defaultValue={pointsText(ffa.placementPoints)} inputMode="numeric" />
        </Field>
      </fieldset>

      <fieldset className="fieldset">
        <legend>{ru ? "Регистрация и составы" : "Registration and rosters"}</legend>
        <input type="hidden" name="registrationFields" value="1" />
        <Check
          name="approvalRequired"
          label={ru ? "Заявки рассматривает организатор (подтверждение или отказ с причиной)" : "The organiser reviews applications (approve, or reject with a reason)"}
          defaultChecked={t?.approval_required ?? false}
        />
        <div className="fieldset-body">
          <div className="form-grid form-grid-4">
            <Field label={ru ? "Регистрация до" : "Registration closes"} hint={ru ? "Пусто — до закрытия вручную" : "Empty = until closed manually"}>
              <LocalDateTimeInput name="registrationClosesAt" iso={iso(t?.registration_closes_at)} />
            </Field>
            <Field label={ru ? "Составы фиксируются" : "Rosters lock"} hint={ru ? "Пусто — при старте" : "Empty = at the start"}>
              <LocalDateTimeInput name="rosterLocksAt" iso={iso(t?.roster_locks_at)} />
            </Field>
            <Field label={ru ? "Неявка через, минут" : "No-show after, minutes"} hint={ru ? "После назначенного времени; пусто — по решению судьи" : "After the scheduled time; empty = at the referee's call"}>
              <input name="noShowMinutes" type="number" min={0} max={240} defaultValue={t?.no_show_minutes ?? ""} inputMode="numeric" />
            </Field>
          </div>
        </div>
        <p className="field-label">{ru ? "Дополнительные вопросы при регистрации" : "Additional registration questions"}</p>
        <p className="small muted">
          {ru
            ? `До ${MAX_FIELDS} вопросов: текст, выбор из списка (варианты через запятую) или флажок. Ответы видят только организаторы и судьи. Не запрашивайте документы, банковские реквизиты и пароли. Вопросы фиксируются после первой заявки.`
            : `Up to ${MAX_FIELDS} questions: text, a choice from a list (comma-separated options) or a checkbox. Only organisers and referees see the answers. Do not ask for identity documents, bank details or passwords. Questions are frozen after the first application.`}
        </p>
        {Array.from({ length: MAX_FIELDS }, (_, i) => {
          const f = fields[i];
          const n = i + 1;
          return (
            <div key={n} className="form-grid form-grid-4 field-row">
              <Field label={ru ? `Вопрос ${n}` : `Question ${n}`}>
                <input name={`field${n}Label`} maxLength={80} defaultValue={f?.label ?? ""} />
              </Field>
              <Field label={ru ? "Тип" : "Type"}>
                <select name={`field${n}Type`} defaultValue={f?.type ?? "text"}>
                  <option value="text">{ru ? "Текст" : "Text"}</option>
                  <option value="choice">{ru ? "Выбор из списка" : "Choice"}</option>
                  <option value="checkbox">{ru ? "Флажок" : "Checkbox"}</option>
                </select>
              </Field>
              <Field label={ru ? "Варианты" : "Options"}>
                <input name={`field${n}Options`} maxLength={1200} defaultValue={f?.options.join(", ") ?? ""} />
              </Field>
              <Check name={`field${n}Required`} label={ru ? "Обязательный" : "Required"} defaultChecked={f?.required ?? false} />
            </div>
          );
        })}
      </fieldset>

      <fieldset className="fieldset">
        <legend>{ru ? "Допуск и расписание" : "Admission and schedule"}</legend>
        <input type="hidden" name="admissionFields" value="1" />
        <p className="small muted">
          {ru
            ? "Критерии проверяются у одиночного игрока или у каждого игрока состава — при заявке и при любом изменении состава; после первой заявки не меняются. Опыт и матчи — только подтверждённые в этой игре. Длительность матча нужна площадкам и проверке пересечений в расписании (пусто — 60 минут)."
            : "Criteria are checked for a solo player or every roster player — at application and whenever a roster changes; they are frozen after the first application. XP and matches count only confirmed activity in this game. The match length drives venues and schedule overlap checks (empty = 60 minutes)."}
        </p>
        <Check name="admissionEmail" label={ru ? "Нужен подтверждённый email" : "A confirmed email is required"} defaultChecked={admission?.emailVerified ?? false} />
        {mailConfigured() ? null : (
          <p className="small notice notice-warn">
            {ru
              ? "Почта портала не подключена: игроки не могут подтвердить email, поэтому этот критерий закроет регистрацию почти для всех."
              : "The portal's email is not connected: players cannot confirm their email, so this criterion would close registration for nearly everyone."}
          </p>
        )}
        <div className="fieldset-body">
          <div className="form-grid form-grid-4">
            <Field label={ru ? "Аккаунт не моложе, дней" : "Account age at least, days"} hint="0–3650">
              <input name="admissionDays" type="number" min={0} max={3650} defaultValue={admission?.minAccountDays ?? ""} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Опыт в этой игре от, XP" : "XP in this game at least"}>
              <input name="admissionXp" type="number" min={0} max={1000000} defaultValue={admission?.minXp ?? ""} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Подтверждённых матчей от" : "Confirmed matches at least"}>
              <input name="admissionMatches" type="number" min={0} max={10000} defaultValue={admission?.minMatches ?? ""} inputMode="numeric" />
            </Field>
            <Field label={ru ? "Длительность матча, минут" : "Match length, minutes"} hint="10–600">
              <input name="matchMinutes" type="number" min={10} max={600} defaultValue={t?.match_minutes ?? ""} inputMode="numeric" />
            </Field>
          </div>
        </div>
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
        <Field label={ru ? "Лимит матчей участника (10–20)" : "Eligible games per participant (10–20)"}><input name="eligibleGameLimit" type="number" min={10} max={20} defaultValue={t?.eligible_game_limit ?? 20} required /></Field>
        <p className="small muted">{ru ? "Используются только в формате leaderboard. Веса фиксируются при старте." : "Used only in the leaderboard format. Weights lock when the tournament starts."}</p>
        <div className="form-grid">
          <Field label={ru ? "Учитывать лучшие N результатов" : "Count best N results"} hint={d.common.optional}>
            <input name="bestOf" type="number" min={1} max={20} defaultValue={t?.best_of ?? ""} />
          </Field>
          <Field label={ru ? "Окно отправки, часов" : "Submission window, hours"} hint={ru ? "Отсчёт со старта. Пусто — без срока." : "Counted from the start. Empty means no deadline."}>
            <input name="submissionHours" type="number" min={1} max={720} defaultValue={t?.submission_hours ?? ""} />
          </Field>
        </div>
        <div className="fieldset-body">
          <div className="form-grid form-grid-4">
            {WEIGHT_KEYS.map((k) => (
              <Field key={k} label={WEIGHT_NAMES[k][lang]} hint={`${ru ? "по умолчанию" : "default"} ${DEFAULT_WEIGHTS[k]}`}>
                <input name={`w_${k}`} type="number" min={0} max={1000} step="any" defaultValue={weights[k]} inputMode="decimal" />
              </Field>
            ))}
          </div>
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
