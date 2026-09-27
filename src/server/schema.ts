/**
 * Ordered, append-only migrations. Never edit an applied migration; add a new one.
 * Each entry is a list of single statements so both node-postgres and PGlite run them.
 */
export type Migration = { id: number; name: string; statements: string[] };

export const migrations: Migration[] = [
  {
    id: 1,
    name: "core_portal",
    statements: [
      `create table users (
        id uuid primary key default gen_random_uuid(),
        email text not null unique,
        username text not null unique,
        display_name text not null,
        password_hash text not null,
        status text not null default 'active' check (status in ('active','suspended','deleted')),
        country text not null default '',
        bio text not null default '',
        profile_public boolean not null default true,
        adult_confirmed_at timestamptz not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create table user_roles (
        user_id uuid not null references users(id) on delete cascade,
        role text not null check (role in ('admin','referee','support')),
        granted_by uuid references users(id),
        granted_at timestamptz not null default now(),
        primary key (user_id, role)
      )`,
      `create table sessions (
        id text primary key,
        user_id uuid not null references users(id) on delete cascade,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        user_agent text not null default ''
      )`,
      `create index sessions_user on sessions(user_id)`,
      `create table auth_attempts (
        id bigserial primary key,
        key text not null,
        ok boolean not null,
        at timestamptz not null default now()
      )`,
      `create index auth_attempts_key on auth_attempts(key, at)`,
      `create table linked_game_accounts (
        user_id uuid not null references users(id) on delete cascade,
        game text not null,
        handle text not null,
        verified boolean not null default false,
        created_at timestamptz not null default now(),
        primary key (user_id, game)
      )`,
      `create table organizations (
        id uuid primary key default gen_random_uuid(),
        slug text not null unique,
        name text not null,
        description text not null default '',
        created_by uuid not null references users(id),
        created_at timestamptz not null default now()
      )`,
      `create table org_members (
        org_id uuid not null references organizations(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        role text not null check (role in ('owner','admin','referee')),
        added_at timestamptz not null default now(),
        primary key (org_id, user_id)
      )`,
      `create table teams (
        id uuid primary key default gen_random_uuid(),
        slug text not null unique,
        name text not null,
        tag text not null default '',
        game text not null,
        owner_id uuid not null references users(id),
        captain_id uuid not null references users(id),
        created_at timestamptz not null default now()
      )`,
      `create table team_members (
        team_id uuid not null references teams(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        joined_at timestamptz not null default now(),
        primary key (team_id, user_id)
      )`,
      `create table team_invites (
        id uuid primary key default gen_random_uuid(),
        team_id uuid not null references teams(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        invited_by uuid not null references users(id),
        status text not null default 'pending' check (status in ('pending','accepted','declined','revoked')),
        created_at timestamptz not null default now(),
        responded_at timestamptz
      )`,
      `create unique index team_invites_pending on team_invites(team_id, user_id) where status = 'pending'`,
      `create table tournaments (
        id uuid primary key default gen_random_uuid(),
        slug text not null unique,
        org_id uuid not null references organizations(id),
        name text not null,
        game text not null,
        format text not null default 'single_elimination' check (format in ('single_elimination')),
        participant_type text not null check (participant_type in ('solo','team')),
        team_size int not null default 1 check (team_size between 1 and 10),
        max_participants int not null check (max_participants between 2 and 512),
        check_in_required boolean not null default true,
        check_in_open boolean not null default false,
        region text not null default '',
        starts_at timestamptz not null,
        description text not null default '',
        rules text not null default '',
        status text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','REGISTRATION_OPEN','REGISTRATION_CLOSED','IN_PROGRESS','PAUSED','COMPLETED','CANCELLED','ARCHIVED')),
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        started_at timestamptz,
        completed_at timestamptz
      )`,
      `create index tournaments_status on tournaments(status, starts_at)`,
      `create table registrations (
        id uuid primary key default gen_random_uuid(),
        tournament_id uuid not null references tournaments(id) on delete cascade,
        user_id uuid references users(id),
        team_id uuid references teams(id),
        registered_by uuid not null references users(id),
        status text not null default 'registered' check (status in ('registered','waitlisted','withdrawn','disqualified','not_checked_in')),
        checked_in_at timestamptz,
        seed int,
        placement int,
        created_at timestamptz not null default now(),
        check ((user_id is null) <> (team_id is null))
      )`,
      `create unique index registrations_user on registrations(tournament_id, user_id) where user_id is not null and status <> 'withdrawn'`,
      `create unique index registrations_team on registrations(tournament_id, team_id) where team_id is not null and status <> 'withdrawn'`,
      `create table roster_entries (
        registration_id uuid not null references registrations(id) on delete cascade,
        tournament_id uuid not null references tournaments(id) on delete cascade,
        user_id uuid not null references users(id),
        captured_at timestamptz not null default now(),
        primary key (registration_id, user_id),
        unique (tournament_id, user_id)
      )`,
      `create table matches (
        id uuid primary key,
        tournament_id uuid not null references tournaments(id) on delete cascade,
        round int not null,
        position int not null,
        a_reg uuid references registrations(id),
        b_reg uuid references registrations(id),
        winner_reg uuid references registrations(id),
        score_a int,
        score_b int,
        status text not null default 'pending' check (status in ('pending','ready','in_progress','result_submitted','disputed','completed','cancelled')),
        outcome text check (outcome in ('played','bye','walkover','no_show','disqualification')),
        next_match_id uuid references matches(id),
        next_slot text check (next_slot in ('a','b')),
        scheduled_at timestamptz,
        room_code text not null default '',
        completed_at timestamptz,
        updated_at timestamptz not null default now(),
        unique (tournament_id, round, position)
      )`,
      `create table match_results (
        id uuid primary key default gen_random_uuid(),
        match_id uuid not null references matches(id) on delete cascade,
        version int not null,
        source text not null check (source in ('participant','official')),
        side text check (side in ('a','b')),
        submitted_by uuid not null references users(id),
        score_a int,
        score_b int,
        winner_reg uuid not null references registrations(id),
        outcome text not null default 'played',
        evidence_url text not null default '',
        note text not null default '',
        status text not null default 'pending' check (status in ('pending','confirmed','rejected','superseded')),
        decided_by uuid references users(id),
        decided_at timestamptz,
        created_at timestamptz not null default now(),
        unique (match_id, version)
      )`,
      `create table disputes (
        id uuid primary key default gen_random_uuid(),
        match_id uuid not null references matches(id) on delete cascade,
        opened_by uuid not null references users(id),
        reason text not null,
        status text not null default 'open' check (status in ('open','resolved')),
        resolution text not null default '',
        resolved_by uuid references users(id),
        created_at timestamptz not null default now(),
        resolved_at timestamptz
      )`,
      `create table applications (
        id uuid primary key default gen_random_uuid(),
        kind text not null,
        name text not null,
        email text not null,
        company text not null default '',
        message text not null default '',
        lang text not null,
        user_id uuid references users(id),
        status text not null default 'new' check (status in ('new','in_review','closed')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create table notifications (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        kind text not null,
        data jsonb not null default '{}',
        read_at timestamptz,
        created_at timestamptz not null default now()
      )`,
      `create index notifications_user on notifications(user_id, created_at desc)`,
      `create table audit_log (
        id bigserial primary key,
        at timestamptz not null,
        actor_id uuid,
        action text not null,
        entity text not null,
        entity_id text not null,
        data jsonb not null default '{}',
        prev_hash text not null,
        hash text not null
      )`,
    ],
  },
];
