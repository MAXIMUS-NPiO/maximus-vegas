/**
 * MV-STAFF-1: platform staff roles and the control-centre sections each may open and act in.
 *
 * The administrator holds every section and alone grants roles, changes account status, approves offers and
 * publishes rules. Every other role holds only its sections; a control-centre action checks the section on
 * the server, so a hidden tab is never the only barrier. Organisers manage their own spaces through
 * organiser roles, which give no access to the platform.
 */
export const STAFF_ROLES = ["admin", "support", "moderation", "referee", "finance", "compliance", "analytics", "marketing", "infrastructure"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const SECTIONS = [
  "overview",
  "users",
  "disputes",
  "challenges",
  "conduct",
  "applications",
  "venues",
  "memberships",
  "offers",
  "payments",
  "outbox",
  "messages",
  "tournaments",
  "sponsors",
  "system",
  "security",
  "audit",
] as const;
export type Section = (typeof SECTIONS)[number];

/** Roles that hold each section besides the administrator. */
export const SECTION_ROLES: Record<Section, readonly StaffRole[]> = {
  overview: ["support", "moderation", "referee", "finance", "compliance", "analytics", "marketing", "infrastructure"],
  users: ["support", "compliance"],
  disputes: ["support", "referee"],
  challenges: ["referee", "moderation", "support"],
  conduct: ["moderation", "support"],
  applications: ["support", "marketing"],
  venues: ["support", "compliance"],
  memberships: ["support", "finance"],
  offers: ["finance"],
  payments: ["finance", "compliance"],
  outbox: ["support", "infrastructure"],
  messages: ["marketing", "support", "infrastructure"],
  tournaments: ["support", "referee", "analytics"],
  sponsors: ["marketing"],
  system: ["infrastructure"],
  security: ["compliance", "infrastructure"],
  audit: ["compliance", "infrastructure"],
};

export const isStaffRole = (role: unknown): role is StaffRole => typeof role === "string" && (STAFF_ROLES as readonly string[]).includes(role);

/** Any platform staff role at all (the control centre and its second factor). */
export const hasStaffRole = (roles: readonly string[]) => roles.some(isStaffRole);

export const hasSection = (roles: readonly string[], section: Section) => roles.includes("admin") || SECTION_ROLES[section].some((r) => roles.includes(r));

export const sectionsFor = (roles: readonly string[]): Section[] => SECTIONS.filter((s) => hasSection(roles, s));

/** Roles to notify about work in a section (the administrator included). */
export const rolesOf = (section: Section): StaffRole[] => ["admin", ...SECTION_ROLES[section]];

/** Who may send which kind of message: marketing needs the marketing role; operational, support or infrastructure. */
export function canSendMessage(roles: readonly string[], kind: "marketing" | "operational") {
  if (roles.includes("admin")) return true;
  return kind === "marketing" ? roles.includes("marketing") : roles.includes("support") || roles.includes("infrastructure");
}
