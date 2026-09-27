export type Inquiry = {
  name: string;
  email: string;
  company: string;
  interest: "partnership" | "investment" | "demo";
  message: string;
  lang: "ru" | "en";
  consent: true;
};
export function validateInquiry(value: unknown): Inquiry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    ["name", "email", "company"].some(
      (key) => typeof v[key] === "string" && /[\r\n]/.test(v[key] as string),
    )
  )
    return null;
  const str = (key: string, limit: number, required = false) => {
    const val = v[key];
    if (val === undefined && !required) return "";
    return typeof val === "string" &&
      val.trim().length <= limit &&
      (!required || val.trim().length > 0)
      ? val.trim()
      : null;
  };
  const name = str("name", 100, true),
    email = str("email", 254, true),
    company = str("company", 150),
    message = str("message", 3000);
  if (
    !name ||
    !email ||
    company === null ||
    message === null ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[\r\n]/.test(name + email) ||
    v.consent !== true ||
    !["partnership", "investment", "demo"].includes(String(v.interest)) ||
    !["ru", "en"].includes(String(v.lang))
  )
    return null;
  return {
    name,
    email: email.toLowerCase(),
    company,
    message,
    interest: v.interest as Inquiry["interest"],
    lang: v.lang as Inquiry["lang"],
    consent: true,
  };
}
