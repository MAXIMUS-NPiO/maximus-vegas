"use client";
import { useEffect, useRef } from "react";

/**
 * Keeps what was typed into a form (never passwords) in this browser tab's session storage, so switching
 * the interface language does not wipe it. It is a convenience only: the server never reads it, it is not
 * sent anywhere, and it is cleared when the form is submitted.
 */
export function DraftKeeper({ formKey, fields }: { formKey: string; fields: string[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const list = fields.join(",");
  useEffect(() => {
    const names = list.split(",");
    const form = ref.current?.closest("form");
    if (!form) return;
    const key = `mv:draft:${formKey}`;
    const read = (): Record<string, string> => {
      try {
        return JSON.parse(window.sessionStorage.getItem(key) ?? "{}") ?? {};
      } catch {
        return {};
      }
    };
    const controls = () =>
      names
        .map((name) => form.elements.namedItem(name))
        .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement && el.type !== "password");
    const saved = read();
    for (const el of controls()) {
      const value = saved[el.name];
      if (value === undefined) continue;
      if (el.type === "checkbox") {
        if (!el.defaultChecked) el.checked = value === "1";
      } else if (!el.value) el.value = value;
    }
    const save = () => {
      const data: Record<string, string> = {};
      for (const el of controls()) data[el.name] = el.type === "checkbox" ? (el.checked ? "1" : "") : el.value.slice(0, 300);
      try {
        window.sessionStorage.setItem(key, JSON.stringify(data));
      } catch {
        /* storage unavailable: nothing to keep */
      }
    };
    const clear = () => {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    };
    form.addEventListener("input", save);
    form.addEventListener("change", save);
    form.addEventListener("submit", clear);
    return () => {
      form.removeEventListener("input", save);
      form.removeEventListener("change", save);
      form.removeEventListener("submit", clear);
    };
  }, [formKey, list]);
  return <span ref={ref} hidden />;
}
