export function siteOrigin(): string | undefined {
  const value =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : undefined);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
export function contactEmail(): string | undefined {
  const email = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}
