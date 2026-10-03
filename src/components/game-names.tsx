import { gameBySlug } from "@/lib/games.ts";
import type { Locale } from "@/lib/i18n.ts";
import { ActionForm } from "./ui";
import { GameNameFields } from "./game-name-fields";

export function GameNames({ lang, back, accounts }: { lang: Locale; back: string; accounts: { game: string; handle: string }[] }) {
  return <>
    {accounts.length ? <ul className="list">
      {accounts.map(a => <li key={JSON.stringify([a.game, a.handle])}>
        <span className="grow">{gameBySlug(a.game)?.name ?? a.game}</span>
        <span className="mono">{a.handle}</span>
        <ActionForm action="account.game" lang={lang} back={back} hidden={{ game: a.game, removeHandle: a.handle }}>
          <button className="btn btn-ghost btn-xs" aria-label={`${lang === "ru" ? "Удалить ник" : "Remove name"} ${a.handle}`}>{lang === "ru" ? "Удалить" : "Remove"}</button>
        </ActionForm>
      </li>)}
    </ul> : null}
    <ActionForm action="account.game" lang={lang} back={back}>
      <GameNameFields key={JSON.stringify(accounts)} lang={lang} accounts={accounts} linkedGames={[...new Set(accounts.map(a => a.game))]} />
    </ActionForm>
  </>;
}
