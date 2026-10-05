export const mpgsSchema = [
  `create table mpgs_sessions (
    id text primary key, merchant_hash text not null, mode text not null check(mode in ('test','live')),
    request jsonb not null, fingerprint text not null, token text not null unique, session_id text unique,
    creation_started boolean not null default false, expires_at timestamptz not null,
    created_at timestamptz not null default now(), checked_at timestamptz
  )`,
  `create index mpgs_reconcile on mpgs_sessions(checked_at nulls first,created_at)`,
];
