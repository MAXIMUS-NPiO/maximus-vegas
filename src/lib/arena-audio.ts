export type Cue = "welcome" | "select" | "launch" | "menu" | "confirm" | "cancel" | "ready";

let context: AudioContext | null = null;
let muted = false;
let initialized = false;
let welcomed = false;
let lastCue = 0;
const listeners = new Set<() => void>();
const preferenceKey = "maximus:arena:sound:v1";

export function readSoundPreference() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try { muted = localStorage.getItem(preferenceKey) === "off"; } catch { /* Storage is optional. */ }
  listeners.forEach((notify) => notify());
}
export const isMuted = () => muted;
export const serverMuted = () => false;
export const subscribeSound = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };

export function setMuted(value: boolean) {
  muted = value;
  try { localStorage.setItem(preferenceKey, value ? "off" : "on"); } catch { /* Private browsing still works. */ }
  if (value) void context?.suspend().catch(() => {});
  listeners.forEach((notify) => notify());
}

const notes: Record<Cue, [number, number, number][]> = {
  welcome: [[220, 0, .26], [330, .08, .28], [440, .18, .3], [660, .29, .35]],
  select: [[760, 0, .045], [1140, .035, .06]],
  launch: [[130, 0, .12], [260, .07, .14], [520, .14, .2]],
  menu: [[440, 0, .07], [550, .055, .07]],
  confirm: [[660, 0, .09], [880, .07, .1], [1320, .14, .13]],
  cancel: [[330, 0, .1], [220, .075, .12]],
  ready: [[1040, 0, .13]],
};

/** Original synthesised UI cues. No media, microphone or network permission is used. */
export function playCue(cue: Cue) {
  if (typeof window === "undefined" || muted || document.hidden) return;
  const now = performance.now();
  if (now - lastCue < 35) return;
  lastCue = now;
  try {
    const Audio = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Audio) return;
    context ||= new Audio();
    const audio = context;
    const play = () => {
      if (muted || document.hidden || audio.state !== "running") return;
      for (const [frequency, delay, length] of notes[cue]) {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const start = audio.currentTime + delay;
        oscillator.type = cue === "launch" ? "triangle" : "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * (cue === "launch" ? 1.3 : .98), start + length);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(.055, start + .008);
        gain.gain.exponentialRampToValueAtTime(.0001, start + length);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(start);
        oscillator.stop(start + length + .015);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      }
    };
    if (audio.state === "suspended") void audio.resume().then(play).catch(() => {});
    else play();
  } catch { /* Audio failure must never interrupt navigation or a form. */ }
}

export function welcomeOnce() {
  if (welcomed || muted) return false;
  welcomed = true;
  playCue("welcome");
  return true;
}

export function suspendAudio() { void context?.suspend().catch(() => {}); }
