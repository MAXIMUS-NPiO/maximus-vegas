/** Additive migration: legacy records remain historical evidence, never silently rewritten. */
export const leaderboardIntegritySchema = [
  `alter table tournaments add column eligible_game_limit int not null default 20 check(eligible_game_limit between 10 and 20)`,
  `alter table score_entries add column revision int not null default 1`,
  `alter table score_entries add column payload_hash text not null default ''`,
  `alter table score_entries add constraint score_match_required check(length(trim(match_ref))>0) not valid`,
  `create table score_match_claims (
    game text not null, account_id uuid not null references users(id) on delete cascade,
    match_ref text not null check(length(match_ref)>0), entry_id uuid not null references score_entries(id) on delete cascade,
    primary key(game,account_id,match_ref)
  )`,
  `create index score_match_claims_entry on score_match_claims(entry_id)`,
  `create table score_entry_revisions (
    entry_id uuid not null references score_entries(id) on delete cascade, revision int not null,
    previous jsonb not null, reason text not null, actor_id uuid references users(id), created_at timestamptz not null default now(),
    primary key(entry_id,revision)
  )`,
];
