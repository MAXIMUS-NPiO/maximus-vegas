export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_input",
  "invalid_email",
  "invalid_username",
  "invalid_name",
  "weak_password",
  "adult_required",
  "consent_required",
  "email_taken",
  "username_taken",
  "invalid_credentials",
  "too_many_attempts",
  "account_suspended",
  "wrong_password",
  "already_registered",
  "roster_conflict",
  "team_too_small",
  "team_too_large",
  "team_game_mismatch",
  "not_team_leader",
  "registration_closed",
  "not_registered",
  "check_in_closed",
  "invalid_transition",
  "not_enough_participants",
  "match_not_ready",
  "not_participant",
  "draw_not_allowed",
  "no_pending_result",
  "own_result",
  "already_completed",
  "dependent_match_played",
  "tournament_not_live",
  "already_member",
  "already_invited",
  "invite_not_found",
  "owner_cannot_leave",
  "last_owner",
  "cannot_modify_self",
  "transfer_ownership_first",
  "invalid_url",
  "invalid_date",
  "invalid_game",
  "wrong_participant_type",
  "not_editable",
  "admin_token_invalid",
  "admin_claim_disabled",
  "db_unavailable",
  "bad_origin",
  "server_error",
  // Formats, leaderboards and disputes
  "format_not_supported",
  "invalid_country",
  "country_required",
  "region_locked",
  "wrong_format",
  "submission_closed",
  "too_many_entries",
  "duplicate_entry",
  "pending_reviews",
  "dispute_exists",
  // Progression and the earn-only economy
  "insufficient_coins",
  "already_owned",
  "not_owned",
  "tier_locked",
  "premium_locked",
  "already_claimed",
  "objective_incomplete",
  "invalid_referral",
  "referral_window_closed",
  // Challenges and quick match
  "challenge_not_found",
  "challenge_closed",
  "cannot_challenge_self",
  "challenge_exists",
  "already_queued",
  // Media
  "invalid_file",
  "file_too_large",
  "upload_limit",
  // Accounts, email and consents
  "signup_unavailable",
  "email_not_configured",
  "token_invalid",
  "email_not_verified",
  "account_not_activated",
  "terms_update_required",
  // Staff MFA
  "mfa_required",
  "mfa_invalid",
  "mfa_not_enrolled",
  "mfa_already_enrolled",
  "step_up_required",
  // Membership and payments
  "offer_unavailable",
  "offer_incomplete",
  "application_exists",
  "application_not_approved",
  "invoice_not_payable",
  "payments_unavailable",
  "checkout_in_progress",
  "terms_required",
  "refunds_disabled",
  "provider_error",
  // Round robin, Swiss and circuits
  "round_robin_limit",
  "invalid_points",
  "invalid_points_table",
  "points_table_locked",
  "circuit_closed",
  "circuit_mismatch",
  "circuit_open_events",
  "not_in_division",
  "not_qualified",
  "regeneration_blocked",
  // Stages, groups and gauntlet
  "invalid_stage_settings",
  "gauntlet_limit",
  "stage_locked",
  "stage_too_few",
  // Registration, rosters, templates, FFA
  "invalid_registration_fields",
  "invalid_answers",
  "roster_locked",
  "invalid_roster",
  "no_show_too_early",
  "template_exists",
  "invalid_ffa_settings",
  "invalid_ffa_results",
  "invalid_series",
  "invalid_series_score",
  "admission_email",
  "admission_account_age",
  "admission_xp",
  "admission_matches",
  "schedule_conflict",
  "venue_exists",
  "venue_in_use",
  "no_venues",
  "feedback_closed",
  "match_closed",
  "match_paused",
  "override_reason_required",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DomainError";
    this.code = code;
  }
}

export const fail = (code: ErrorCode, message?: string): never => {
  throw new DomainError(code, message);
};

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string; message?: string };
  if (e?.code !== "23505") return false;
  if (!constraint) return true;
  return e.constraint === constraint || Boolean(e.message?.includes(constraint));
}
