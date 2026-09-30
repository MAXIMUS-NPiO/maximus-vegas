import { dict, type Locale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { ActionForm, Field } from "./ui";

export type CircuitDefaults = {
  id?: string;
  name?: string;
  season?: string;
  game?: string;
  participant_type?: string;
  description?: string;
  points_table?: number[];
  participation_points?: number;
  qualify_top?: number;
  divisions?: number;
  promote?: number;
  relegate?: number;
};

/** Default points for places 1–8: a common esports-style curve the organiser can replace. */
export const DEFAULT_CIRCUIT_TABLE = "100, 70, 50, 35, 25, 15, 10, 5";

export function CircuitForm({ lang, back, orgId, c, locked }: { lang: Locale; back: string; orgId?: string; c?: CircuitDefaults; locked?: { table: boolean; divisions: boolean } }) {
  const d = dict(lang);
  const o = d.organizer;
  const ru = lang === "ru";
  const editing = Boolean(c?.id);
  return (
    <ActionForm action={editing ? "circuit.update" : "circuit.create"} lang={lang} back={back} hidden={editing ? { circuit: c!.id! } : { org: orgId! }} className="card form-card">
      <div className="form-grid">
        <Field label={ru ? "Название серии" : "Circuit name"}>
          <input name="name" required minLength={2} maxLength={80} defaultValue={c?.name} />
        </Field>
        <Field label={ru ? "Сезон" : "Season"} hint={ru ? "Например: 2026 или Весна 2027" : "For example: 2026 or Spring 2027"}>
          <input name="season" required maxLength={40} defaultValue={c?.season ?? String(new Date().getUTCFullYear())} />
        </Field>
        {editing ? null : (
          <>
            <Field label={o.game} hint={ru ? "Только игры с матчами «сторона против стороны»." : "Head-to-head games only."}>
              <select name="game" required defaultValue={c?.game ?? "cs2"}>
                {GAMES.filter((g) => g.bracket).map((g) => (
                  <option key={g.slug} value={g.slug}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={o.participantType}>
              <select name="participantType" defaultValue={c?.participant_type ?? "team"}>
                <option value="team">{o.team}</option>
                <option value="solo">{o.solo}</option>
              </select>
            </Field>
          </>
        )}
      </div>
      <Field
        label={ru ? "Очки за места 1, 2, 3 …" : "Points for places 1, 2, 3 …"}
        hint={
          locked?.table
            ? ru
              ? "Заблокировано: в серии уже есть завершённый турнир."
              : "Locked: an event of this circuit has been completed."
            : ru
              ? "Через запятую, без роста к нижним местам. Разделённое место получает очки своей строки."
              : "Comma-separated, never rising for lower places. A shared place earns its own row."
        }
      >
        <input name="pointsTable" required maxLength={400} defaultValue={c?.points_table?.join(", ") ?? DEFAULT_CIRCUIT_TABLE} readOnly={locked?.table} inputMode="numeric" />
      </Field>
      <div className="form-grid form-grid-4">
        <Field label={ru ? "Очки за участие" : "Participation points"} hint={ru ? "Места ниже таблицы" : "Places below the table"}>
          <input name="participationPoints" type="number" min={0} max={1000} defaultValue={c?.participation_points ?? 0} readOnly={locked?.table} />
        </Field>
        <Field label={ru ? "Квалифицируются (топ N)" : "Qualify (top N)"} hint={ru ? "0 — без квалификации" : "0 = no qualification"}>
          <input name="qualifyTop" type="number" min={0} max={256} defaultValue={c?.qualify_top ?? 0} />
        </Field>
        <Field label={ru ? "Дивизионов" : "Divisions"} hint={locked?.divisions ? (ru ? "Не меняется после первых турниров или участников" : "Fixed once events or members exist") : "1–5"}>
          <input name="divisions" type="number" min={1} max={5} defaultValue={c?.divisions ?? 1} readOnly={locked?.divisions} />
        </Field>
        <Field label={ru ? "Повышаются" : "Promoted"} hint={ru ? "Лучших из каждого нижнего дивизиона" : "Top members of each lower division"}>
          <input name="promote" type="number" min={0} max={64} defaultValue={c?.promote ?? 0} />
        </Field>
        <Field label={ru ? "Понижаются" : "Relegated"} hint={ru ? "Худших из каждого верхнего дивизиона" : "Bottom members of each upper division"}>
          <input name="relegate" type="number" min={0} max={64} defaultValue={c?.relegate ?? 0} />
        </Field>
      </div>
      <Field label={ru ? "Описание" : "Description"} hint={d.common.optional}>
        <textarea name="description" rows={3} maxLength={2000} defaultValue={c?.description} />
      </Field>
      <p className="small muted">
        {ru
          ? "Очки турнира = очки места × вес турнира / 100 с округлением до целого (0,5 — вверх). Порядок: очки → победы в турнирах → лучшее место → число турниров. Правила MV-CIRCUIT-1."
          : "Event points = place points × event weight / 100, rounded to a whole number (0.5 up). Order: points → event wins → best place → events played. Rules MV-CIRCUIT-1."}
      </p>
      <button className="btn btn-primary">{editing ? d.common.save : ru ? "Создать серию" : "Create circuit"}</button>
    </ActionForm>
  );
}
