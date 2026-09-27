"use client";
import { useEffect, useState } from "react";

/** Renders a UTC instant in the visitor's own time zone, with the zone name. */
export function LocalTime({
  iso,
  lang,
  withZone = true,
  dateOnly = false,
}: {
  iso: string | Date | null | undefined;
  lang: "ru" | "en";
  withZone?: boolean;
  dateOnly?: boolean;
}) {
  const value = iso ? new Date(iso) : null;
  const locale = lang === "ru" ? "ru-RU" : "en-GB";
  const opts: Intl.DateTimeFormatOptions = dateOnly
    ? { day: "numeric", month: "short", year: "numeric" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  const [text, setText] = useState(() =>
    value ? new Intl.DateTimeFormat(locale, { ...opts, timeZone: "UTC" }).format(value) + (dateOnly || !withZone ? "" : " UTC") : "—",
  );
  useEffect(() => {
    if (!value) return;
    const formatted = new Intl.DateTimeFormat(locale, { ...opts, ...(withZone && !dateOnly ? { timeZoneName: "short" } : {}) }).format(value);
    setText(formatted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso, lang]);
  return <time dateTime={value?.toISOString()}>{text}</time>;
}

/** Hidden field carrying the visitor's IANA time zone so the server can convert local input to UTC. */
export function TimeZoneField() {
  const [zone, setZone] = useState("UTC");
  useEffect(() => {
    try {
      setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } catch {
      setZone("UTC");
    }
  }, []);
  return <input type="hidden" name="tz" value={zone} />;
}

/** datetime-local input pre-filled from a UTC instant in the visitor's zone. */
export function LocalDateTimeInput({ name, iso, required }: { name: string; iso?: string | null; required?: boolean }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    setValue(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
  }, [iso]);
  return (
    <input
      type="datetime-local"
      name={name}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      required={required}
    />
  );
}

/** Live countdown to a UTC instant (updates every 15 s). The server remains the authority on the deadline. */
export function Countdown({ iso, lang }: { iso: string | Date; lang: "ru" | "en" }) {
  const target = new Date(iso).getTime();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return null;
  const left = target - now;
  const ru = lang === "ru";
  if (left <= 0) return <span className="countdown">{ru ? "срок истёк" : "closed"}</span>;
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor((left % 86_400_000) / 3_600_000);
  const m = Math.max(1, Math.ceil((left % 3_600_000) / 60_000));
  const parts = [d ? `${d} ${ru ? "д" : "d"}` : "", h ? `${h} ${ru ? "ч" : "h"}` : "", !d ? `${m} ${ru ? "мин" : "min"}` : ""].filter(Boolean);
  return (
    <span className="countdown" aria-live="off">
      {ru ? "осталось" : "left"}: {parts.join(" ")}
    </span>
  );
}
