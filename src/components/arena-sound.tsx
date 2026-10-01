"use client";
import { useEffect, useSyncExternalStore } from "react";
import { isMuted, playCue, readSoundPreference, serverMuted, setMuted, subscribeSound, suspendAudio, welcomeOnce, type Cue } from "@/lib/arena-audio";
import type { Locale } from "@/lib/i18n";

export function ArenaSound() {
  useEffect(() => {
    readSoundPreference();
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button,a,summary,[role=button]") : null;
      if (!target || target.matches(":disabled,[aria-disabled=true]") || target.dataset.sound === "none" || target.closest("[data-sound=none]")) return;
      if (welcomeOnce()) return;
      const explicit = target.dataset.sound;
      const href = target.getAttribute("href") || "";
      let cue: Cue = "select";
      if (explicit && ["welcome", "select", "launch", "menu", "confirm", "cancel", "ready"].includes(explicit)) cue = explicit as Cue;
      else if (target.tagName === "SUMMARY" || target.hasAttribute("aria-expanded")) cue = "menu";
      else if (/matchmaking|tournaments|signup/.test(href)) cue = "launch";
      else if (target.matches("button[type=submit]") || target.closest("form")) cue = "confirm";
      else if (target.matches(".btn-danger")) cue = "cancel";
      playCue(cue);
    };
    const visibility = () => { if (document.hidden) suspendAudio(); };
    document.addEventListener("click", click, true);
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("click", click, true); document.removeEventListener("visibilitychange", visibility); suspendAudio(); };
  }, []);
  return null;
}

export function SoundToggle({ lang }: { lang: Locale }) {
  const muted = useSyncExternalStore(subscribeSound, isMuted, serverMuted);
  const label = lang === "ru" ? (muted ? "Включить звук" : "Выключить звук") : (muted ? "Turn sound on" : "Mute sound");
  return <button type="button" className={`sound-toggle ${muted ? "is-muted" : ""}`} aria-label={label} aria-pressed={!muted} title={label} data-sound="none" onClick={() => { setMuted(!muted); if (muted) { if (!welcomeOnce()) playCue("select"); } }}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" />{muted ? <path d="m17 9 5 6m0-6-5 6" /> : <><path d="M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14" /></>}</svg>
    <span className="sound-label">{lang === "ru" ? "Звук" : "Sound"}</span>
  </button>;
}
