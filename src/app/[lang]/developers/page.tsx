import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { siteOrigin } from "@/lib/site.ts";
import { integrationsText } from "@/lib/integrations-text.ts";
import { BACKOFF_MINUTES, KEY_LIMIT, ENDPOINT_LIMIT, RATE_PER_MINUTE, WEBHOOK_EVENTS } from "@/server/partner.ts";
import { PageHead } from "@/components/ui";

const T = {
  ru: {
    title: "Разработчикам",
    lead: "API для чтения турниров, подписанные вебхуки и встраиваемые виджеты для организаторов и партнёров MAXIMUS VEGAS. Доступ выдаёт владелец или администратор пространства организатора в разделе «API, вебхуки и виджеты».",
    access: "Доступ",
    accessText: `Ключ API и адреса вебхуков создаются в пространстве организатора. Ключ видит турниры только своего пространства, включая черновики; турнир другого пространства отвечает 404 так же, как несуществующий. До ${KEY_LIMIT} действующих ключей и ${ENDPOINT_LIMIT} адресов вебхуков на пространство.`,
    auth: "Авторизация и лимиты",
    authText: `Передавайте ключ в заголовке Authorization. Не более ${RATE_PER_MINUTE} запросов в минуту на ключ: сверх лимита — 429 с заголовком Retry-After. Неверный, отозванный или отсутствующий ключ — 401. API только читает данные: изменить турнир через API нельзя.`,
    endpoints: "Методы",
    list: [
      ["GET /api/v1/organization", "пространство, которому принадлежит ключ"],
      ["GET /api/v1/tournaments", "турниры пространства: статус, формат, игра, старт, участники"],
      ["GET /api/v1/tournaments/{slug}", "турнир и его участники с местами и посевом"],
      ["GET /api/v1/tournaments/{slug}/matches", "матчи: этап, раунд, стороны, счёт, победитель, время"],
      ["GET /api/v1/tournaments/{slug}/standings", "таблица: очки (круговая, швейцарская), группы, leaderboard или итоговые места"],
    ],
    errors: "Ошибки",
    errorsText: "Ответ с ошибкой — JSON с кодом и пояснением; коды: unauthorized, rate_limited, not_found, method_not_allowed, unavailable.",
    hooks: "Вебхуки",
    hooksText: `Портал отправляет POST с JSON на ваш HTTPS-адрес. Ответьте кодом 2xx в течение 5 секунд; перенаправления не выполняются. При ошибке доставка повторяется через ${BACKOFF_MINUTES.join(", ")} минут; после шестой неудачной попытки её можно повторить вручную. Адреса во внутренних сетях не принимаются.`,
    events: "События",
    signature: "Подпись и защита от повтора",
    signatureText:
      "Каждый запрос подписан секретом адреса (показывается один раз при создании и при смене). Проверьте подпись по сырому телу запроса, отклоните метку времени, отстоящую больше чем на 5 минут, и идентификатор события, который вы уже принимали: повторённый запрос тогда отклоняется. Во время смены секрета заголовок может содержать несколько значений v1=.",
    widgets: "Виджеты",
    widgetsText:
      "Виджет — страница для iframe на вашем сайте: сетка, регистрация и таблица турнира, календарь пространства. Показываются опубликованные турниры; ссылки открывают портал в новой вкладке; регистрация проходит на портале. Код вставки — в разделе «API, вебхуки и виджеты» пространства.",
    test: "Проверка интеграции",
    testText:
      "Кнопка «Отправить тестовое событие» шлёт подписанное событие ping на выбранный адрес — так проверяется приёмник и проверка подписи. Для полного прогона создайте отдельное пространство организатора: его черновые и тестовые турниры видны только ключу этого пространства, а события его турниров уходят только на его адреса.",
    toSpaces: "Пространства организатора",
  },
  en: {
    title: "Developers",
    lead: "A read API for tournaments, signed webhooks and embeddable widgets for MAXIMUS VEGAS organisers and partners. Access is granted by an owner or administrator of an organising space in its “API, webhooks and widgets” section.",
    access: "Access",
    accessText: `API keys and webhook addresses are created in an organising space. A key sees only its own space's tournaments, drafts included; another space's tournament answers 404, the same as a missing one. Up to ${KEY_LIMIT} active keys and ${ENDPOINT_LIMIT} webhook addresses per space.`,
    auth: "Authorisation and limits",
    authText: `Send the key in the Authorization header. At most ${RATE_PER_MINUTE} requests a minute per key: above it, 429 with a Retry-After header. A wrong, revoked or missing key gets 401. The API only reads data: a tournament cannot be changed through it.`,
    endpoints: "Endpoints",
    list: [
      ["GET /api/v1/organization", "the space the key belongs to"],
      ["GET /api/v1/tournaments", "the space's tournaments: status, format, game, start, participants"],
      ["GET /api/v1/tournaments/{slug}", "a tournament and its participants with places and seeds"],
      ["GET /api/v1/tournaments/{slug}/matches", "matches: stage, round, sides, score, winner, time"],
      ["GET /api/v1/tournaments/{slug}/standings", "standings: points table (round robin, Swiss), groups, leaderboard or final places"],
    ],
    errors: "Errors",
    errorsText: "An error is JSON with a code and a message; codes: unauthorized, rate_limited, not_found, method_not_allowed, unavailable.",
    hooks: "Webhooks",
    hooksText: `The portal sends a JSON POST to your HTTPS address. Answer 2xx within 5 seconds; redirects are not followed. A failure is retried after ${BACKOFF_MINUTES.join(", ")} minutes; after the sixth failed attempt it can be retried by hand. Addresses in private networks are refused.`,
    events: "Events",
    signature: "Signature and replay protection",
    signatureText:
      "Every request is signed with the address's secret (shown once when created and when replaced). Verify the signature over the raw request body, reject a timestamp more than 5 minutes away and an event id you have already accepted: a replayed request is then refused. During a secret change the header may carry several v1= values.",
    widgets: "Widgets",
    widgetsText:
      "A widget is a page for an iframe on your site: a tournament's bracket, registration and standings, and a space's calendar. Published tournaments are shown; links open the portal in a new tab; registration happens on the portal. The embed code is in the space's “API, webhooks and widgets” section.",
    test: "Testing an integration",
    testText:
      "“Send a test event” sends a signed ping event to the chosen address — this checks the receiver and its signature check. For a full run, create a separate organising space: its draft and test tournaments are seen only by that space's key, and its events go only to its addresses.",
    toSpaces: "Organising spaces",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "developers", T[lang].title, T[lang].lead);
}

export default async function Developers({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = T[lang];
  const ev = integrationsText[lang].eventNames;
  const origin = siteOrigin() ?? "https://www.maximus.vegas";
  const verify = `import { createHmac, timingSafeEqual } from "node:crypto";

const seen = new Set(); // keep accepted ids in a database in production

export function verifyWebhook(headers, rawBody, secret) {
  const id = headers["mv-webhook-id"];
  const ts = headers["mv-webhook-timestamp"];
  const sig = headers["mv-webhook-signature"];
  if (!id || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // stale
  const expected = "v1=" + createHmac("sha256", secret).update(\`\${id}.\${ts}.\${rawBody}\`).digest("hex");
  const ok = sig.split(" ").some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok || seen.has(id)) return false; // forged or replayed
  seen.add(id);
  return true;
}`;
  const payload = `{
  "id": "evt_1042",
  "type": "match.completed",
  "created_at": "2026-10-01T18:04:11.000Z",
  "data": {
    "tournament": { "id": "…", "slug": "autumn-cup", "name": "Autumn Cup", "game": "cs2", "format": "single_elimination", "status": "IN_PROGRESS", "url": "${origin}/ru/tournaments/autumn-cup" },
    "match": { "id": "…", "round": 2, "position": 1, "status": "completed", "a_name": "Night Owls", "b_name": "Iron Wolves", "score_a": 2, "score_b": 1, "winner": "a" }
  }
}`;
  return (
    <div className="container page prose-page">
      <PageHead title={x.title} lead={x.lead}>
        <Link href={`/${lang}/organizer`} className="btn btn-ghost btn-sm">
          {x.toSpaces}
        </Link>
      </PageHead>
      <section className="section-tight">
        <h2 className="h3">{x.access}</h2>
        <p>{x.accessText}</p>
      </section>
      <section className="section-tight">
        <h2 className="h3">{x.auth}</h2>
        <p>{x.authText}</p>
        <pre className="code-block">{`curl -H "Authorization: Bearer mvk_…" ${origin}/api/v1/tournaments`}</pre>
      </section>
      <section className="section-tight">
        <h2 className="h3">{x.endpoints}</h2>
        <ul className="list">
          {x.list.map(([path, text]) => (
            <li key={path}>
              <code className="mono small break-all">{path}</code>
              <span className="small muted">{text}</span>
            </li>
          ))}
        </ul>
        <pre className="code-block">{`{ "data": [ { "slug": "autumn-cup", "name": "Autumn Cup", "game": "cs2", "status": "REGISTRATION_OPEN", "registered": 12, "max_participants": 16, "starts_at": "2026-10-12T16:00:00.000Z", "url": "${origin}/ru/tournaments/autumn-cup" } ] }`}</pre>
        <h3 className="h4">{x.errors}</h3>
        <p className="small">{x.errorsText}</p>
        <pre className="code-block">{`{ "error": { "code": "not_found", "message": "No such resource for this key." } }`}</pre>
      </section>
      <section className="section-tight">
        <h2 className="h3">{x.hooks}</h2>
        <p>{x.hooksText}</p>
        <h3 className="h4">{x.events}</h3>
        <ul className="list small">
          {[...WEBHOOK_EVENTS, "ping"].map((e) => (
            <li key={e}>
              <code className="mono">{e}</code>
              <span className="muted">{ev[e] ?? (lang === "ru" ? "тестовое событие" : "test event")}</span>
            </li>
          ))}
        </ul>
        <pre className="code-block">{payload}</pre>
        <h3 className="h4">{x.signature}</h3>
        <p className="small">{x.signatureText}</p>
        <pre className="code-block">{`MV-Webhook-Id: evt_1042
MV-Webhook-Timestamp: 1790877851
MV-Webhook-Signature: v1=<hex HMAC-SHA256(secret, "evt_1042.1790877851." + body)>`}</pre>
        <pre className="code-block">{verify}</pre>
      </section>
      <section className="section-tight">
        <h2 className="h3">{x.widgets}</h2>
        <p>{x.widgetsText}</p>
        <pre className="code-block">{`<iframe src="${origin}/embed/${lang}/tournaments/{slug}/bracket" title="Bracket" width="100%" height="560" style="border:0" loading="lazy"></iframe>
/embed/${lang}/tournaments/{slug}/registration
/embed/${lang}/tournaments/{slug}/standings
/embed/${lang}/organizer/{space}/calendar`}</pre>
      </section>
      <section className="section-tight">
        <h2 className="h3">{x.test}</h2>
        <p>{x.testText}</p>
      </section>
    </div>
  );
}
