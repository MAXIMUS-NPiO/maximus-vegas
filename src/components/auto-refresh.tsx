"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Re-renders the page from the server every few seconds while it is visible (queue and ready check). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

/** Seconds left until a deadline, updated every second; the server remains the authority. */
export function SecondsLeft({ iso, lang }: { iso: string | Date; lang: "ru" | "en" }) {
  const target = new Date(iso).getTime();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return null;
  const left = Math.max(0, Math.ceil((target - now) / 1000));
  return (
    <span className="countdown" aria-live="polite">
      {left > 0 ? (lang === "ru" ? `осталось ${left} с` : `${left} s left`) : lang === "ru" ? "время вышло" : "time is up"}
    </span>
  );
}
