import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { challengesFor, queueState } from "@/server/challenges.ts";
import { ActionForm, DbDown, Field, Flash, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";
import { ChallengeList } from "@/components/challenges";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(
    lang,
    "matchmaking",
    lang === "ru" ? "Быстрый матч" : "Quick match",
    lang === "ru" ? "Соперник из реальной очереди по вашей игре. Без ставок." : "An opponent from the real queue for your game. No stakes.",
  );
}

export default async function QuickMatch({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  const back = `/${lang}/matchmaking`;
  return (
    <div className="container page">
      <PageHead
        eyebrow={T("ИГРАТЬ", "PLAY")}
        title={T("Быстрый матч", "Quick match")}
        lead={T(
          "Выберите игру — портал соединит вас с реальным игроком, который уже ждёт в очереди этой игры. Если никого нет, вы встанете в очередь на 30 минут. Без ставок, без ботов, без выдуманных соперников.",
          "Pick a game — the portal pairs you with a real player already waiting in that game's queue. If nobody is waiting, you join the queue for 30 minutes. No stakes, no bots, no invented opponents.",
        )}
      >
        <Link href={`/${lang}/challenges`} className="btn btn-ghost btn-sm">
          {T("Вызвать конкретного игрока", "Challenge a specific player")}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      {dbError || !db ? (
        <DbDown lang={lang} />
      ) : !user ? (
        <SignInPrompt lang={lang} back={back} />
      ) : (
        <QuickMatchBody lang={lang} userId={user.id} back={back} />
      )}
    </div>
  );
}

async function QuickMatchBody({ lang, userId, back }: { lang: "ru" | "en"; userId: string; back: string }) {
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const { db } = await viewer();
  const [state, list] = await Promise.all([queueState(db!, userId), challengesFor(db!, userId)]);
  const quick = list.filter((c) => c.kind === "quick");
  return (
    <div className="stack">
      {state.mine ? (
        <section className="card stack-sm">
          <p className="field-label">{T("Вы в очереди", "You are queued")}</p>
          <p>
            {GAMES.find((g) => g.slug === state.mine!.game)?.name} · {T("ожидаем реального соперника", "waiting for a real opponent")}
          </p>
          <ActionForm action="quick.leave" lang={lang} back={back}>
            <button className="btn btn-ghost btn-sm">{T("Выйти из очереди", "Leave the queue")}</button>
          </ActionForm>
        </section>
      ) : (
        <ActionForm action="quick.join" lang={lang} back={back} className="card form-card">
          <Field label={T("Игра", "Game")}>
            <select name="game" required>
              {GAMES.filter((g) => !g.legacy).map((g) => (
                <option key={g.slug} value={g.slug}>
                  {g.name}
                  {state.waiting[g.slug] ? ` · ${T("ждут", "waiting")}: ${state.waiting[g.slug]}` : ""}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-primary">{T("Найти соперника", "Find an opponent")}</button>
          <p className="small muted">{T("Результат подтверждает соперник; спорный результат решает команда портала.", "The opponent confirms the result; the portal team decides disputed results.")}</p>
        </ActionForm>
      )}
      <section>
        <h2 className="h3">{T("Мои быстрые матчи", "My quick matches")}</h2>
        <ChallengeList lang={lang} list={quick} userId={userId} back={back} />
      </section>
    </div>
  );
}
