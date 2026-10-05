"use client";
import { useState } from "react";
import type { Locale } from "@/lib/i18n.ts";

export function GameNameFields({ lang, linkedGames, accounts, catalog }: { lang: Locale; linkedGames: string[]; accounts: {game:string;handle:string}[]; catalog:{slug:string;name:string}[] }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const remaining = catalog.filter(g => !linkedGames.includes(g.slug));
  const linked = catalog.filter(g => linkedGames.includes(g.slug));
  const [mode, setMode] = useState(remaining.length ? "new" : "another");
  const games = mode === "new" ? remaining : linked;
  const [selected, setSelected] = useState("");
  const [handle, setHandle] = useState("");
  const game = games.some(g => g.slug === selected) ? selected : games[0]?.slug ?? "";
  const duplicate = accounts.some(a => a.game === game && a.handle === handle.trim().replace(/[\r\n\t]+/g, " "));
  return <>
    {!remaining.length ? <p className="small muted" role="status">{T("Ники добавлены во все игры. Можно добавить ещё один ник к выбранной игре.", "Every game has a name. You can add another name to a selected game.")}</p> : null}
    <div className="stack-sm">
      <label className="field">
        <span className="field-label">{T("Что добавить", "What to add")}</span>
        <select aria-label={T("Что добавить", "What to add")} value={mode} onChange={e => { setMode(e.target.value); setSelected(""); setHandle(""); }}>
          {remaining.length ? <option value="new">{T("Ник для новой игры", "Name for a new game")}</option> : null}
          {linked.length ? <option value="another">{T("Добавить ещё один ник к этой же игре", "Add another name for the same game")}</option> : null}
        </select>
      </label>
      <label className="field">
        <span className="field-label">{mode === "another" ? T("В какую игру добавить ещё один ник", "Which game needs another name") : T("Игра", "Game")}</span>
        <select key={mode} name="game" required aria-label={T("Игра", "Game")} value={game} onChange={e => setSelected(e.target.value)}>
          {games.map(g => <option key={g.slug} value={g.slug}>{g.name}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="field-label">{T("Ник в игре", "In-game name")}</span>
        <input name="handle" value={handle} onChange={e=>setHandle(e.target.value)} required maxLength={60} aria-label={T("Ник в игре", "In-game name")} />
      </label>
      {duplicate ? <p role="status" className="small muted">{T("Этот ник уже добавлен к выбранной игре.", "This name is already added to this game.")}</p> : null}
      {!duplicate ? <button className="btn btn-ghost btn-sm" disabled={!games.length || !handle.trim()}>{mode === "another" ? T("Добавить ещё один ник", "Add another name") : T("Добавить ник", "Add name")}</button> : null}
    </div>
  </>;
}
