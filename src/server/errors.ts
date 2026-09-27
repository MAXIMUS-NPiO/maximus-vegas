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
