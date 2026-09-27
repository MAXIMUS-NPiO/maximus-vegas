import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { challengesFor } from "@/server/challenges.ts";
import { ActionForm, DbDown, Field, Flash, one, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";
import { ChallengeList } from "@/components/challenges";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "challenges", lang === "ru" ? "Вызовы 1v1" : "1v1 challenges", undefined, { noindex: true });
}

export default async function Challenges({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  const back = `/${lang}/challenges`;
  const list = db && user ? await challengesFor(db, user.id) : [];
  const named = list.filter((c) => c.kind === "challenge");
  return (
    <div className="container page">
      <PageHead
        eyebrow={T("ИГРАТЬ", "PLAY")}
        title={T("Вызовы 1v1", "1v1 challenges")}
        lead={T(
          "Вызовите конкретного игрока на матч в выбранной игре. Соперник принимает или отклоняет вызов, результат подтверждает вторая сторона. Ставок нет: победа приносит только XP.",
          "Challenge a specific player to a match in a chosen game. They accept or decline, and the other side confirms the result. There are no stakes: a win earns XP only.",
        )}
      >
        <Link href={`/${lang}/matchmaking`} className="btn btn-ghost btn-sm">
          {T("Быстрый матч без выбора соперника", "Quick match without choosing")}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      {dbError || !db ? (
        <DbDown lang={lang} />
      ) : !user ? (
        <SignInPrompt lang={lang} back={back} />
      ) : (
        <div className="split">
          <section>
            <h2 className="h3">{T("Мои вызовы", "My challenges")}</h2>
            <ChallengeList lang={lang} list={named} userId={user.id} back={back} />
          </section>
          <ActionForm action="challenge.create" lang={lang} back={back} className="card form-card">
            <h2 className="h4">{T("Новый вызов", "New challenge")}</h2>
            <Field label={T("Имя пользователя соперника", "Opponent's username")}>
              <input name="opponent" required pattern="[A-Za-z0-9_]{3,24}" defaultValue={one(sp.to)} autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={T("Игра", "Game")}>
              <select name="game" required>
                {GAMES.map((g) => (
                  <option key={g.slug} value={g.slug}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={T("Сообщение", "Message")} hint={T("необязательно", "optional")}>
              <textarea name="message" rows={2} maxLength={300} />
            </Field>
            <button className="btn btn-primary">{T("Отправить вызов", "Send challenge")}</button>
            <p className="small muted">{T("Вызов действует 72 часа. Никаких монет и денег на кону.", "A challenge is open for 72 hours. No coins or money are at stake.")}</p>
          </ActionForm>
        </div>
      )}
    </div>
  );
}
