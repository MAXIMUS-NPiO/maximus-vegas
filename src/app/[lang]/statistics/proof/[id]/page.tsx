import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { snapshotProof } from "@/server/statistics.ts";
import { DbDown, PageHead } from "@/components/ui";
import { StatsVerifier } from "@/components/stats-verifier";
export const metadata = { title: "MAXIMUS · Statistics proof", robots: { index: false, follow: false } };
export default async function ProofPage({ params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params; if (!isLocale(lang)) notFound(); const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />; const p = await snapshotProof(db, id, user?.id); if (!p) notFound();
  return <div className="container page narrow"><PageHead title={T("Доказательство целостности", "Integrity proof")} /><p>{T("Записей", "Records")}: {p.count}</p><code className="break-all">{p.root}</code><p>{p.anchor ? T("Запись в настроенном блокчейн-контракте проверена", "Inclusion in the configured blockchain contract was verified") : T("Включение в блокчейн не подтверждено", "Blockchain inclusion is not verified")}</p>{p.anchor && <pre className="prewrap break-all">{JSON.stringify(p.anchor, null, 2)}</pre>}<p>{T("Публичная ссылка не раскрывает записи. Чтобы проверить отдельный факт, попросите владельца предоставить файл этой записи с доказательством включения.", "The public link does not reveal records. To verify a specific fact, request its record and inclusion proof from the owner.")}</p><a className="btn btn-primary" href={`/api/statistics/proofs/${id}`}>{T("Скачать доказательство", "Download proof")}</a><StatsVerifier lang={lang} /><Link className="text-link" href={`/${lang}/statistics`}>{T("Моя статистика", "My statistics")}</Link></div>;
}
