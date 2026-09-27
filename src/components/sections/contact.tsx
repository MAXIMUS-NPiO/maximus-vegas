import type { Copy, Locale } from "@/lib/content";
import { ArrowUp } from "@/components/icons";
import { contactEmail } from "@/lib/site";
import { InquiryForm } from "@/components/inquiry-form";

export function Contact({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <section id="contact" className="section contact-section">
      <div className="container contact-layout">
        <div>
          <p className="eyebrow">{c.contactLabel}</p>
          <h2>{c.contactTitle}</h2>
          <p>{c.contactDesc}</p>
          <span className="contact-detail">{c.contactDetail}</span>
          {contactEmail() && (
            <a className="contact-email" href={`mailto:${contactEmail()}`}>
              {contactEmail()}
              <ArrowUp />
            </a>
          )}
        </div>
        <InquiryForm
          lang={lang}
          copy={c.form}
          email={contactEmail()}
          enabled={Boolean(process.env.LEAD_WEBHOOK_URL)}
        />
      </div>
    </section>
  );
}
