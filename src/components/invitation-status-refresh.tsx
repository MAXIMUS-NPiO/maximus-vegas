"use client";
import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "@/lib/i18n.ts";

export function InvitationStatusRefresh({ lang }: { lang: Locale }) {
  const router = useRouter(), [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") router.refresh(); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [router]);
  return <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => startTransition(() => router.refresh())}>{pending ? lang === "ru" ? "Обновляем…" : "Refreshing…" : lang === "ru" ? "Обновить статус" : "Refresh status"}</button>;
}
