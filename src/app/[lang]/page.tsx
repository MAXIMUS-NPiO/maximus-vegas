import { notFound } from "next/navigation";
import { content, isLocale } from "@/lib/content";
import { Hero } from "@/components/sections/hero";
import { Metrics } from "@/components/sections/metrics";
import { Ecosystem } from "@/components/sections/ecosystem";
import { Partners } from "@/components/sections/partners";
import { Business } from "@/components/sections/business";
import { About } from "@/components/sections/about";
import { Faq } from "@/components/sections/faq";
import { Contact } from "@/components/sections/contact";
import { Footer } from "@/components/sections/footer";

export default async function Home({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const c = content[lang];
  return (
    <>
      <main id="main">
        <Hero lang={lang} c={c} />
        <Metrics lang={lang} c={c} />
        <Ecosystem lang={lang} c={c} />
        <Partners lang={lang} c={c} />
        <Business lang={lang} c={c} />
        <About lang={lang} c={c} />
        <Faq lang={lang} c={c} />
        <Contact lang={lang} c={c} />
      </main>
      <Footer lang={lang} c={c} />
    </>
  );
}
