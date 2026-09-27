"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowUp } from "./icons";
import type { Copy, Locale } from "@/lib/content";

export function InquiryForm({
  lang,
  copy,
  email,
  enabled,
}: {
  lang: Locale;
  copy: Copy["form"];
  email?: string;
  enabled: boolean;
}) {
  const [status, setStatus] = useState<
    "idle" | "sending" | "success" | "error"
  >("idle");
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const res = await fetch("/api/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(data),
          consent: data.get("consent") === "on",
          lang,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        setError(res.status === 503 ? copy.unavailable : copy.error);
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch {
      setError(copy.error);
      setStatus("error");
    }
  }
  if (!enabled)
    return (
      <div className="contact-unavailable">
        <span className="eyebrow">LET’S CONNECT</span>
        <h3>{lang === "ru" ? "Открыты к диалогу." : "Open to possibility."}</h3>
        <p>
          {email
            ? lang === "ru"
              ? "Напишите нам о вашем проекте, инвестиционном интересе или запросе на демонстрацию."
              : "Email us about your project, investment interest or a product demonstration."
            : copy.unavailable}
        </p>
        {email && (
          <a className="button" href={`mailto:${email}`}>
            {email}
            <ArrowUp />
          </a>
        )}
      </div>
    );
  return (
    <form className="inquiry-form" onSubmit={submit}>
      {status === "success" ? (
        <div className="form-success" role="status" tabIndex={-1}>
          <span className="success-icon">✓</span>
          <h3>{copy.success}</h3>
          <button
            type="button"
            className="text-link"
            onClick={() => setStatus("idle")}
          >
            {copy.retry}
            <ArrowUp />
          </button>
        </div>
      ) : (
        <>
          <div className="form-row">
            <label>
              {copy.name} <span aria-hidden="true">*</span>
              <input name="name" required autoComplete="name" maxLength={100} />
            </label>
            <label>
              {copy.email} <span aria-hidden="true">*</span>
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                maxLength={254}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              {copy.company} <span className="optional">({copy.optional})</span>
              <input
                name="company"
                autoComplete="organization"
                maxLength={150}
              />
            </label>
            <label>
              {copy.interest}
              <select name="interest" defaultValue="partnership">
                {["partnership", "investment", "demo"].map((value, i) => (
                  <option key={value} value={value}>
                    {copy.interests[i]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {copy.message} <span className="optional">({copy.optional})</span>
            <textarea
              name="message"
              rows={3}
              maxLength={3000}
              placeholder={copy.messagePlaceholder}
            />
          </label>
          <div className="honeypot" aria-hidden="true">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <label className="consent">
            <input type="checkbox" name="consent" required />
            <span>
              {copy.consent}{" "}
              <Link href={`/${lang}/privacy`}>{copy.privacy}</Link>.
            </span>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button form-submit"
            type="submit"
            disabled={status === "sending"}
          >
            {status === "sending" ? copy.sending : copy.submit}
            <ArrowUp />
          </button>
          {email && (
            <p className="form-email">
              {copy.fallback} <a href={`mailto:${email}`}>{email}</a>
            </p>
          )}
        </>
      )}
    </form>
  );
}
