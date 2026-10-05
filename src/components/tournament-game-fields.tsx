"use client";
import { useState } from "react";
import type { Locale } from "@/lib/i18n.ts";
import { formatLabels } from "@/lib/catalog-labels.ts";
export function TournamentGameFields({
  lang,
  games,
  initialGame,
  initialFormat,
  editing,
}: {
  lang: Locale;
  games: { slug: string; name: string; formats: string[] }[];
  initialGame?: string;
  initialFormat?: string;
  editing: boolean;
}) {
  const T = (ru: string, en: string) => (lang === "ru" ? ru : en);
  const [selected, setSelected] = useState(initialGame ?? games[0]?.slug ?? "");
  const game = games.find((g) => g.slug === selected) ?? games[0];
  const formats = [...(game?.formats ?? [])];
  // Keep an existing event operable even if its catalog format was later retired.
  if (
    editing &&
    game?.slug === initialGame &&
    initialFormat &&
    !formats.includes(initialFormat)
  )
    formats.push(initialFormat);
  const [choice, setChoice] = useState(initialFormat ?? "single_elimination");
  const format = formats.includes(choice) ? choice : (formats[0] ?? "");
  return (
    <>
      <label className="field">
        <span className="field-label">{T("Игра", "Game")}</span>
        <select
          name="game"
          required
          value={game?.slug ?? ""}
          onChange={(e) => setSelected(e.target.value)}
        >
          {games.map((g) => (
            <option key={g.slug} value={g.slug}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">{T("Формат", "Format")}</span>
        <select
          name="format"
          required
          value={format}
          onChange={(e) => setChoice(e.target.value)}
        >
          {formats.map((f) => (
            <option key={f} value={f}>
              {formatLabels[f]?.[lang === "ru" ? 0 : 1] ?? f}
            </option>
          ))}
        </select>
        <span className="field-hint">
          {T(
            "Доступные форматы берутся из каталога. Результаты вводятся и проверяются вручную, пока не подключён подтверждённый источник данных.",
            "Available formats come from the catalog. Results are submitted and reviewed manually until a verified data source is connected.",
          )}
        </span>
      </label>
    </>
  );
}
