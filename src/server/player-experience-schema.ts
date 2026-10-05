/** Additive statements, appended to the canonical migrations by the core lane. */
export const playerExperienceSchema = [
  `create table player_experience_identities (
    user_id uuid primary key references users(id) on delete cascade,
    steam_id text not null unique check (steam_id ~ '^[0-9]{17}$'),
    verified_at timestamptz not null default now(),
    consent_version text not null,
    consented_at timestamptz not null default now()
  )`,
  `create table player_experience_states (
    state_hash text primary key,
    user_id uuid not null references users(id) on delete cascade,
    session_hash text not null,
    return_to text not null,
    lang text not null check (lang in ('ru','en')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    used_at timestamptz
  )`,
  `create index player_experience_states_user on player_experience_states(user_id,created_at)`,
  `create table player_experience_nonces (
    nonce_hash text primary key,
    user_id uuid not null references users(id) on delete cascade,
    expires_at timestamptz not null
  )`,
  `create table player_experience_connections (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references player_experience_identities(user_id) on delete cascade,
    provider text not null check (provider in ('steam','opendota','faceit')),
    external_id text,
    display_name text not null default '',
    status text not null default 'pending' check (status in ('pending','available','private','unavailable','error')),
    issue text not null default '',
    shared boolean not null default false,
    consent_version text not null,
    consented_at timestamptz not null default now(),
    verified_at timestamptz,
    last_attempt_at timestamptz,
    last_success_at timestamptz,
    next_sync_at timestamptz not null default now(),
    lease_token text,
    lease_until timestamptz,
    failures integer not null default 0,
    records jsonb not null default '[]'::jsonb check (jsonb_typeof(records)='array'),
    unique(user_id,provider),
    unique(provider,external_id)
  )`,
  `create index player_experience_sync_due on player_experience_connections(next_sync_at)`,
  `create table player_experience_settings (
    user_id uuid primary key references users(id) on delete cascade,
    share_partner boolean not null default false
  )`,
  `create table player_experience_budgets (
    provider text not null,
    bucket text not null,
    requests integer not null default 0,
    expires_at timestamptz not null,
    primary key(provider,bucket)
  )`,
];
