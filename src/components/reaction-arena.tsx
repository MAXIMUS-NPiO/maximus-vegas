"use client";
import { useEffect, useRef, useState } from "react";
import { playCue } from "@/lib/arena-audio";
import type { Locale } from "@/lib/i18n";

type Phase = "idle" | "waiting" | "ready" | "result" | "early" | "done";
const bestKey = "maximus:reaction:best:v1";

export function ReactionArena({ lang }: { lang: Locale }) {
  const ru = lang === "ru";
  const [phase, setPhase] = useState<Phase>("idle");
  const [scores, setScores] = useState<number[]>([]);
  const [best, setBest] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const readyAt = useRef(0);
  const set = (next: Phase) => { phaseRef.current = next; setPhase(next); };
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => {
    try { const value = Number(localStorage.getItem(bestKey)); if (value > 0 && Number.isFinite(value)) setBest(value); } catch {}
    const hidden = () => { if (document.hidden && ["waiting", "ready"].includes(phaseRef.current)) { clear(); set("idle"); setScores([]); } };
    document.addEventListener("visibilitychange", hidden);
    return () => { clear(); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  function wait() {
    clear(); set("waiting");
    timer.current = setTimeout(() => {
      readyAt.current = performance.now(); set("ready"); playCue("ready");
    }, 1300 + Math.random() * 2000);
  }
  function act() {
    const current = phaseRef.current;
    if (current === "waiting") { clear(); set("early"); playCue("cancel"); return; }
    if (current === "ready") {
      const reaction = Math.max(1, Math.round(performance.now() - readyAt.current));
      const next = [...scores, reaction]; setScores(next); playCue("confirm");
      if (next.length === 5) {
        set("done");
        const average = Math.round(next.reduce((a, b) => a + b, 0) / next.length);
        if (!best || average < best) { setBest(average); try { localStorage.setItem(bestKey, String(average)); } catch {} }
      } else set("result");
      return;
    }
    if (current === "done" || current === "idle") setScores([]);
    playCue("launch"); wait();
  }
  const average = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const title = phase === "ready" ? (ru ? "ЖМИ!" : "NOW!") : phase === "waiting" ? (ru ? "ЖДИ СИГНАЛ" : "WAIT FOR IT") : phase === "early" ? (ru ? "СЛИШКОМ РАНО" : "TOO EARLY") : phase === "result" ? `${scores.at(-1)} ${ru ? "мс" : "ms"}` : phase === "done" ? `${average} ${ru ? "мс" : "ms"}` : (ru ? "ПРОВЕРЬ РЕАКЦИЮ" : "TEST YOUR REFLEXES");
  const hint = phase === "idle" ? (ru ? "5 сигналов. Твой лучший результат." : "5 signals. Set your personal best.") : phase === "ready" ? (ru ? "Нажми на мишень" : "Hit the target") : phase === "waiting" ? (ru ? "Мишень станет голубой" : "The target will turn cyan") : phase === "early" ? (ru ? "Нажми, чтобы повторить попытку" : "Tap to retry this round") : phase === "done" ? (ru ? "Средняя реакция · сыграть ещё" : "Average reaction · play again") : (ru ? "Нажми для следующего сигнала" : "Tap for the next signal");
  return <div className="reaction-panel" data-phase={phase}>
    <div className="reaction-top"><span>{ru ? "РАЗМИНКА" : "WARM-UP"}</span><span>{String(Math.min(scores.length + 1, 5)).padStart(2, "0")} / 05</span></div>
    <button type="button" className="reaction-target" data-sound="none" onClick={act} onKeyDown={(event) => { if (event.repeat && (event.key === " " || event.key === "Enter")) event.preventDefault(); }} aria-label={`${title}. ${hint}`}>
      <span className="reticle" aria-hidden="true"><svg viewBox="0 0 100 100" fill="none"><circle cx="50" cy="50" r="32" /><circle cx="50" cy="50" r="18" /><path d="M50 8v18m0 48v18M8 50h18m48 0h18" /><circle cx="50" cy="50" r="3" fill="currentColor" /></svg></span>
      <strong>{title}</strong><span>{hint}</span>
    </button>
    <div className="reaction-bottom" aria-live="polite"><span>{ru ? "РЕКОРД" : "BEST"}</span><b>{best ? `${best} ${ru ? "мс" : "ms"}` : "—"}</b></div>
    <p className="reaction-note">{ru ? "Локальная разминка. Не влияет на рейтинг." : "Local warm-up. Does not affect your rank."}</p>
  </div>;
}
