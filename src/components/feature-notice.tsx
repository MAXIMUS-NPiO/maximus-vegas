import type { Locale } from "@/lib/i18n.ts";
import type { Database } from "@/server/db.ts";
import { featureEnabled, type Feature } from "@/server/system.ts";

/** A feature switched off by the portal team says so on its page (MV-STAFF-1); what is under way can still be finished. */
export async function FeatureNotice({ db, lang, feature }: { db: Database | null | undefined; lang: Locale; feature: Feature }) {
  if (!db || (await featureEnabled(db, feature).catch(() => true))) return null;
  return (
    <p className="notice notice-warn small" role="status">
      {lang === "ru"
        ? "Команда портала временно выключила эту функцию: новое начать нельзя, начатое можно завершить."
        : "The portal team has switched this feature off for now: nothing new can start, and what is under way can be finished."}
    </p>
  );
}
