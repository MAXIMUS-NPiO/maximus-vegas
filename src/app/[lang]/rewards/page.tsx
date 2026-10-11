import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import styles from "./rewards.module.css";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "rewards", "MAXIMUS Rewards", lang === "ru"
    ? "Проект общей бонусной программы MAXIMUS: игры, теннис, тренировки и одежда."
    : "Explore the planned MAXIMUS rewards programme across gaming, tennis, training and fashion.");
}

export default async function Rewards({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const directions = [
    ["01", "MAXIMUS VEGAS", T("Игровые сервисы и опыт", "Gaming services and experiences")],
    ["02", "MAXIMUS TENNIS", T("Ракетки, оборудование и тренировки", "Racquets, equipment and training")],
    ["03", "MAXIMUS BABY TENNIS", T("Семейные программы развития", "Family development programmes")],
    ["04", "SHALENI", T("Одежда и стиль", "Fashion and personal style")],
    ["05", T("ДЕТСКАЯ ОДЕЖДА", "CHILDREN’S CLOTHING"), T("Следующее направление экосистемы", "A future ecosystem category")],
  ];
  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="rewards-title">
        <p className={styles.eyebrow}>MAXIMUS REWARDS</p>
        <p className={styles.status}>{T("ПРОГРАММА В РАЗРАБОТКЕ", "PROGRAMME IN DEVELOPMENT")}</p>
        <h1 id="rewards-title">{T("Поддерживайте MAXIMUS.", "Support MAXIMUS.")}<br /><span>{T("Открывайте больше.", "Enjoy more.")}</span></h1>
        <p className={styles.lead}>{T(
          "Одна экосистема для игры, спорта и жизни. Мы готовим общую программу, чтобы бонусы за подходящие взносы, покупки и участие можно было использовать в разных направлениях MAXIMUS.",
          "One ecosystem for play, sport and everyday life. We are building a shared programme so rewards from eligible contributions, purchases and participation can be used across MAXIMUS.",
        )}</p>
        <a className="btn btn-primary" href="#rewards-how">{T("Как это будет работать", "Explore the programme")}</a>
        <p className={styles.availability}>{T(
          "Приём взносов, начисление и использование общих бонусов ещё не открыты.",
          "Contributions, shared reward accrual and redemption are not open yet.",
        )}</p>
      </section>

      <section className={styles.annual} aria-labelledby="annual-title">
        <div className={styles.rate} aria-hidden="true">20<span>%</span></div>
        <div>
          <p className={styles.eyebrow}>{T("ПЛАНИРУЕМАЯ МОДЕЛЬ", "PROPOSED MODEL")}</p>
          <h2 id="annual-title">{T("20% в год — бонусами внутри экосистемы", "20% a year in ecosystem rewards")}</h2>
          <p>{T(
            "Рабочая модель: 20% от первоначальной подходящей суммы в конце каждого года, без начисления бонусов на бонусы. Это номинал бонусов для товаров и услуг, а не денежные проценты или доступные к выводу средства.",
            "The working model credits 20% of the initial eligible amount at the end of each year, without compounding. This is the nominal value of rewards for goods and services, not cash interest or a withdrawable balance.",
          )}</p>
          <p className={styles.note}>{T(
            "Срок, подходящие взносы, возвраты, лимиты и перечень товаров будут определены в условиях программы до её запуска. Покупки и игровые достижения получат собственные правила начисления.",
            "The term, qualifying contributions, refunds, limits and eligible catalogue will be defined in the programme terms before launch. Purchases and gaming activity will have their own reward rules.",
          )}</p>
        </div>
      </section>

      <section id="rewards-how" className={styles.section} aria-labelledby="rewards-how-title">
        <p className={styles.eyebrow}>{T("В ОБЕ СТОРОНЫ", "REWARDS THAT CONNECT")}</p>
        <h2 id="rewards-how-title">{T("Из спорта — в игру. Из игры — в жизнь.", "From sport to play. From play to everyday life.")}</h2>
        <div className={styles.flow}>
          <article><span className={styles.step}>01</span><h3>{T("Участвуйте", "Take part")}</h3><p>{T(
            "Поддерживайте подходящую программу, покупайте товары или участвуйте в подтверждённых активностях. У каждого способа будут свои условия.",
            "Support an eligible programme, shop or join qualifying activities. Each route will have its own terms.",
          )}</p></article>
          <article><span className={styles.step}>02</span><h3>{T("Накапливайте", "Build rewards")}</h3><p>{T(
            "Общий бонусный баланс будет показывать источник начислений, доступный остаток и историю. Он будет отделён от игровых XP и монет.",
            "A shared rewards balance will show where credits came from, what is available and the full history. It will remain separate from game XP and coins.",
          )}</p></article>
          <article><span className={styles.step}>03</span><h3>{T("Выбирайте", "Choose your next experience")}</h3><p>{T(
            "Планируем связать бонусы теннисных программ с игровыми сервисами Vegas, а бонусы за подходящие активности Vegas — с ракетками, тренировками и одеждой.",
            "We plan to connect tennis programme rewards with Vegas gaming services, and eligible Vegas activity rewards with racquets, training and clothing.",
          )}</p></article>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ecosystem-title">
        <p className={styles.eyebrow}>{T("ПЛАНИРУЕМЫЕ НАПРАВЛЕНИЯ", "PLANNED DESTINATIONS")}</p>
        <h2 id="ecosystem-title">{T("Больше возможностей в MAXIMUS", "More possibilities across MAXIMUS")}</h2>
        <ol className={styles.destinations}>
          {directions.map(([number, name, description]) => <li key={number}><span className={styles.number}>{number}</span><h3>{name}</h3><p>{description}</p><span className={styles.planned}>{T("Планируется", "Planned")}</span></li>)}
        </ol>
        <p className={styles.note}>{T(
          "Каталог, поставщики и обмен между проектами ещё не подключены. Семейные бонусы не меняют возрастные правила Vegas: аккаунты доступны с 18 лет.",
          "The catalogue, merchants and cross-project redemption are not connected yet. Family rewards do not change Vegas age rules: accounts remain available from 18.",
        )}</p>
      </section>

      <section className={styles.fairPlay}>
        <h2>{T("Игра остаётся бесплатной", "The competition stays free")}</h2>
        <p>{T(
          "Бонусы не станут ставками и не дадут преимущества в рейтинге, посеве или результатах турниров. Текущие игровые монеты сохраняют свои правила.",
          "Rewards will not become stakes or give an advantage in rankings, seeding or tournament results. Existing game coins keep their current rules.",
        )}</p>
        <div className={styles.links}><Link href={`/${lang}/games`} className="btn btn-primary">{T("Выбрать игру", "Choose a game")}</Link><Link href={`/${lang}/terms`} className="btn btn-ghost">{T("Действующие условия", "Current terms")}</Link></div>
      </section>
    </div>
  );
}
