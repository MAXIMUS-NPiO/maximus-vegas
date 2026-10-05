import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { experienceAvailability, profileExperience, syncOwnExperience } from "@/server/player-experience.ts";
import { featureEnabled, maintenanceState } from "@/server/system.ts";
import { DbDown, Flash, PageHead, one, type SearchParams } from "@/components/ui";
import { PlayerExperienceCard } from "@/components/player-experience";

export const metadata = { title: "MAXIMUS · Player experience", robots: { index: false, follow: false } };
export const maxDuration = 60;
export default async function ExperiencePage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params; if (!isLocale(lang)) notFound();
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />; if (!user) redirect(`/${lang}/signin?next=/${lang}/experience`);
  const T = (ru: string, en: string) => lang === "ru" ? ru : en, search = await searchParams;
  after(async () => { try { if (!(await maintenanceState(db)).on && await featureEnabled(db, "integrations")) await syncOwnExperience(db, user); } catch { /* No secret-bearing provider errors are logged. */ } });
  const messages: Record<string, string> = { verified: T("Steam-аккаунт подтверждён. Теперь выберите источники для импорта.", "Steam account verified. Choose the sources to import below."), connected: T("Источник подключён. Результат первой попытки импорта показан ниже.", "Source connected. The result of the first import attempt appears below."), checked: T("Попытка обновления завершена. Текущее состояние источника показано ниже.", "Refresh attempt completed. The source's current state appears below."), disconnected: T("Привязка и импортированные данные удалены.", "The connection and its imported data were removed."), saved: T("Настройки видимости сохранены.", "Visibility settings saved.") };
  return <div className="container page"><PageHead title={T("История игрока", "Player history")} lead={T("Вы приходите со своим опытом. Подключите его один раз и поддерживайте историю в актуальном состоянии.", "You bring your experience with you. Connect it once and keep your history up to date.")}><Link className="btn btn-ghost" href={`/${lang}/players/${user.username}`}>{T("Мой профиль", "My profile")}</Link><a className="btn btn-ghost" href="/api/experience/export">{T("Скачать импортированные данные", "Download imported data")}</a></PageHead><Flash lang={lang} params={search} />
    {messages[one(search.result)] && <p className="flash flash-ok" role="status">{messages[one(search.result)]}</p>}
    <PlayerExperienceCard lang={lang} data={await profileExperience(db, user.id, user.id)} availability={experienceAvailability()} manage />
  </div>;
}
