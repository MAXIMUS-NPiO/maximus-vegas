"use client";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Gamepad, Trophy, Users } from "./icons";
import { ReactionArena } from "./reaction-arena";
import type { Locale } from "@/lib/i18n";

const choices = [
  { slug: "cs2", name: "Counter-Strike 2", code: "CS2", kind: "5 VS 5", image: "/experience/cs2.jpg" },
  { slug: "dota2", name: "Dota 2", code: "DOTA 2", kind: "5 VS 5", image: "/experience/dota2.jpg" },
  { slug: "apex", name: "Apex Legends", code: "APEX", kind: "BATTLE ROYALE", image: "/experience/apex.jpg" },
  { slug: "trackmania", name: "Trackmania", code: "TRACKMANIA", kind: "RACING", image: "/experience/trackmania.jpg" },
];

export function ArenaLobby({ lang, name }: { lang: Locale; name?: string }) {
  const ru = lang === "ru";
  const [chosen, choose] = useState(0);
  const game = choices[chosen];
  return <section className="arena-lobby" aria-labelledby="arena-title">
    <Image className="arena-background" src="/experience/arena.webp" alt="" fill sizes="100vw" preload />
    <div className="arena-shade" />
    <div className="arena-content container">
      <div className="arena-topline"><p>{ru ? `Добро пожаловать${name ? `, ${name}` : ", игрок"}.` : `Welcome${name ? `, ${name}` : ", player"}.`}</p><span>MAXIMUS VEGAS — Vegas для своих</span></div>
      <div className="arena-main">
        <div className="arena-copy">
          <p className="arena-eyebrow">{ru ? "ТВОЯ ИГРА. ТВОЯ КОМАНДА." : "YOUR GAME. YOUR SQUAD."}</p>
          <h1 id="arena-title">{ru ? <>ВХОДИ<br />В ИГРУ<span>.</span></> : <>ENTER<br />THE GAME<span>.</span></>}</h1>
          <p className="arena-intro">{ru ? "Найди соперника. Собери команду. Оставь свой след." : "Find your rival. Build your squad. Make your mark."}</p>
          <div className="arena-actions">
            <Link className="btn btn-primary arena-primary" href={`/${lang}/matchmaking?game=${game.slug}`} data-sound="launch"><Gamepad />{ru ? "Найти матч" : "Find a match"}</Link>
            <Link className="btn btn-ghost" href={`/${lang}/tournaments?game=${game.slug}`} data-sound="launch"><Trophy />{ru ? "Турниры" : "Tournaments"}</Link>
          </div>
          <p className="arena-selected" aria-live="polite"><span>{game.name}</span> · {ru ? "Матчи проходят в самой игре" : "Matches take place in the game"}</p>
        </div>
        <ReactionArena lang={lang} />
      </div>
      <div className="arena-selector">
        <div className="arena-selector-label"><span>{ru ? "ВЫБЕРИ ДИСЦИПЛИНУ" : "CHOOSE YOUR GAME"}</span><Link href={`/${lang}/games`}>{ru ? "Все игры" : "All games"}</Link></div>
        <div className="arena-choices" role="group" aria-label={ru ? "Игра для матча" : "Game for matchmaking"}>
          {choices.map((item, index) => <button type="button" key={item.slug} className={`arena-choice ${chosen === index ? "is-selected" : ""}`} aria-pressed={chosen === index} onClick={() => choose(index)} data-sound="select">
            <Image src={item.image} alt="" width={460} height={215} sizes="(max-width: 640px) 150px, 240px" /><span><strong>{item.code}</strong><small>{item.kind}</small></span><span className="choice-indicator" aria-hidden="true" />
          </button>)}
        </div>
      </div>
    </div>
    <div className="arena-bottom-nav container">
      <Link href={`/${lang}/challenges`} data-sound="launch"><span className="arena-nav-icon"><Gamepad /></span><span><strong>{ru ? "Бросить вызов" : "Challenge a rival"}</strong><small>{ru ? "Один на один" : "One versus one"}</small></span><b>01</b></Link>
      <Link href={`/${lang}/teams`}><span className="arena-nav-icon"><Users /></span><span><strong>{ru ? "Найти команду" : "Find your squad"}</strong><small>{ru ? "Собери свой состав" : "Build your roster"}</small></span><b>02</b></Link>
      <Link href={`/${lang}/progress`} data-sound="confirm"><span className="arena-nav-icon"><Trophy /></span><span><strong>{ru ? "Твой прогресс" : "Your progression"}</strong><small>{ru ? "Ранги, цели, сезон" : "Ranks, goals, season"}</small></span><b>03</b></Link>
    </div>
  </section>;
}
