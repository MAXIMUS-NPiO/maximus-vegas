import type { Locale } from "@/lib/i18n.ts";

/** Saved final places have no historical points or KDA snapshot. Never infer those metrics here. */
export function FinalPlacements({ lang, rows }: {
  lang: Locale;
  rows: ReadonlyArray<{ registration: string; name: string | null; placement: number | null }>;
}) {
  const ru = lang === "ru";
  if (!rows.length)
    return <p className="muted">{ru ? "Итоговые места не сохранены." : "Final placements were not recorded."}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{ru ? "Место" : "Place"}</th>
            <th>{ru ? "Участник" : "Participant"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.registration}>
              <td>{row.placement}</td>
              <td>{row.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
