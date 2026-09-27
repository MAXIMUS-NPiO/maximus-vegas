"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Prevents a form from being sent twice (double click, impatient re-click on a slow network) and marks its
 * buttons busy. The server stays the authority — actions are idempotent where it matters — this only
 * removes accidental duplicates. Returning with the browser's Back button re-enables the form.
 */
export function SubmitGuard({ pending }: { pending?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const buttons = () => Array.from(form.querySelectorAll<HTMLButtonElement>("button:not([type=button])"));
    const onSubmit = (event: SubmitEvent) => {
      if (form.dataset.submitting === "1") {
        event.preventDefault();
        return;
      }
      form.dataset.submitting = "1";
      for (const b of buttons()) b.setAttribute("aria-busy", "true");
      setBusy(true);
    };
    const reset = () => {
      delete form.dataset.submitting;
      for (const b of buttons()) b.removeAttribute("aria-busy");
      setBusy(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", reset);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", reset);
    };
  }, []);

  if (!pending) return <span ref={ref} hidden />;
  return (
    <span ref={ref} className="small muted submit-pending" aria-live="polite">
      {busy ? pending : ""}
    </span>
  );
}
