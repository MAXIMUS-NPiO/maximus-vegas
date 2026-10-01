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
  {
    id: 2,
    name: "formats_disputes_awards",
    statements: [
      // Formats: double elimination and leaderboard. Constraint changes only widen what is allowed.
      `alter table tournaments drop constraint if exists tournaments_format_check`,
      `alter table tournaments add constraint tournaments_format_check check (format in ('single_elimination','double_elimination','leaderboard'))`,
      `alter table tournaments add column scoring jsonb`,
      `alter table tournaments add column best_of int check (best_of between 1 and 50)`,
      `alter table tournaments add column submission_hours int check (submission_hours between 1 and 720)`,
      `alter table tournaments add column submission_deadline timestamptz`,
      `alter table tournaments add column region_lock text[] not null default '{}'`,
      `alter table tournaments add column prize_coins int not null default 0 check (prize_coins between 0 and 100000)`,
      `alter table tournaments add column prize_text text not null default ''`,
      `alter table tournaments add column livestream_url text not null default ''`,
      `alter table matches add column bracket text not null default 'W' check (bracket in ('W','L','GF'))`,
      `alter table matches drop constraint if exists matches_tournament_id_round_position_key`,
      `alter table matches add constraint matches_slot_key unique (tournament_id, bracket, round, position)`,
      `alter table matches add column loser_next_match_id uuid references matches(id)`,
      `alter table matches add column loser_next_slot text check (loser_next_slot in ('a','b'))`,
      `alter table matches add column a_void boolean not null default false`,
      `alter table matches add column b_void boolean not null default false`,
      `alter table matches add column a_checked_in_at timestamptz`,
      `alter table matches add column b_checked_in_at timestamptz`,
      `alter table matches drop constraint if exists matches_outcome_check`,
      `alter table matches add constraint matches_outcome_check check (outcome in ('played','bye','walkover','no_show','disqualification','decision'))`,
      // Post-result disputes: uphold or overturn a decided match.
      `alter table disputes add column kind text not null default 'pre_result' check (kind in ('pre_result','post_result'))`,
      `alter table disputes add column evidence_url text not null default ''`,
      `alter table disputes add column decision text check (decision in ('upheld','overturned'))`,
      `create unique index disputes_open_post on disputes(match_id) where status = 'open' and kind = 'post_result'`,
      `create index disputes_opened_by on disputes(opened_by, kind, decision)`,
      // Co-organisers of a single tournament.
      `create table tournament_organizers (
        tournament_id uuid not null references tournaments(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        added_by uuid not null references users(id),
        added_at timestamptz not null default now(),
        primary key (tournament_id, user_id)
      )`,
      // Leaderboard score log.
      `create table score_entries (
        id uuid primary key default gen_random_uuid(),
        tournament_id uuid not null references tournaments(id) on delete cascade,
        registration_id uuid not null references registrations(id) on delete cascade,
        submitted_by uuid not null references users(id),
        source text not null check (source in ('participant','organizer')),
        kills int not null check (kills between 0 and 999),
        assists int not null check (assists between 0 and 999),
        deaths int not null check (deaths between 0 and 999),
        headshots int not null check (headshots between 0 and 999),
        damage int not null check (damage between 0 and 99999),
        distance int not null check (distance between 0 and 999999),
        placement int check (placement in (1,2,3)),
        match_ref text not null default '',
        evidence_url text not null default '',
        flags text[] not null default '{}',
        review text not null check (review in ('accepted','pending','approved','rejected')),
        reviewed_by uuid references users(id),
        reviewed_at timestamptz,
        review_note text not null default '',
        created_at timestamptz not null default now()
      )`,
      `create index score_entries_reg on score_entries(tournament_id, registration_id)`,
      `create unique index score_entries_match_ref on score_entries(tournament_id, registration_id, match_ref) where match_ref <> '' and review <> 'rejected'`,
      // Champion awards: idempotent per champion registration, never per tournament.
      `create table tournament_awards (
        tournament_id uuid not null references tournaments(id) on delete cascade,
        registration_id uuid not null references registrations(id),
        kind text not null check (kind in ('champion')),
        coins int not null check (coins >= 0),
        created_at timestamptz not null default now(),
        primary key (tournament_id, registration_id, kind)
      )`,
    ],
  },
  {
    id: 3,
    name: "progression_community_media",
    statements: [
      `alter table users add column country_code text check (country_code ~ '^[A-Z]{2}$')`,
      `alter table users add column avatar_color text not null default ''`,
      `alter table users add column onboarded_at timestamptz`,
      // Existing accounts never see the first-run flow.
      `update users set onboarded_at = created_at`,
      `alter table users add column referral_code text unique`,
      `create table wallets (
        user_id uuid primary key references users(id) on delete cascade,
        balance int not null default 0 check (balance >= 0),
        updated_at timestamptz not null default now()
      )`,
      `create table coin_ledger (
        id bigserial primary key,
        user_id uuid not null references users(id) on delete cascade,
        delta int not null check (delta <> 0),
        reason text not null,
        ref text not null default '',
        idem_key text not null unique,
        balance_after int not null,
        created_at timestamptz not null default now()
      )`,
      `create index coin_ledger_user on coin_ledger(user_id, id desc)`,
      `create table xp_events (
        id bigserial primary key,
        user_id uuid not null references users(id) on delete cascade,
        amount int not null check (amount > 0),
        reason text not null,
        game text not null default '',
        ref text not null default '',
        idem_key text not null unique,
        created_at timestamptz not null default now()
      )`,
      `create index xp_events_user on xp_events(user_id, game)`,
      `create table objective_claims (
        user_id uuid not null references users(id) on delete cascade,
        objective text not null,
        claimed_at timestamptz not null default now(),
        primary key (user_id, objective)
      )`,
      `create table pass_unlocks (
        user_id uuid not null references users(id) on delete cascade,
        season text not null,
        source text not null check (source in ('coins','membership')),
        unlocked_at timestamptz not null default now(),
        primary key (user_id, season)
      )`,
      `create table pass_claims (
        user_id uuid not null references users(id) on delete cascade,
        season text not null,
        tier int not null,
        track text not null check (track in ('free','premium')),
        claimed_at timestamptz not null default now(),
        primary key (user_id, season, tier, track)
      )`,
      `create table user_cosmetics (
        user_id uuid not null references users(id) on delete cascade,
        item text not null,
        source text not null check (source in ('shop','pass','objective','membership')),
        acquired_at timestamptz not null default now(),
        primary key (user_id, item)
      )`,
      `create table referral_redemptions (
        referee_id uuid primary key references users(id) on delete cascade,
        referrer_id uuid not null references users(id) on delete cascade,
        code text not null,
        created_at timestamptz not null default now(),
        referrer_rewarded_at timestamptz,
        check (referee_id <> referrer_id)
      )`,
      `create table challenges (
        id uuid primary key default gen_random_uuid(),
        kind text not null check (kind in ('challenge','quick')),
        game text not null,
        challenger_id uuid not null references users(id),
        opponent_id uuid not null references users(id),
        message text not null default '',
        status text not null default 'pending' check (status in ('pending','accepted','declined','cancelled','expired','reported','completed','disputed')),
        reported_by uuid references users(id),
        reported_winner uuid references users(id),
        score_challenger int check (score_challenger between 0 and 999),
        score_opponent int check (score_opponent between 0 and 999),
        winner_id uuid references users(id),
        evidence_url text not null default '',
        resolution text not null default '',
        resolved_by uuid references users(id),
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        responded_at timestamptz,
        completed_at timestamptz,
        check (challenger_id <> opponent_id)
      )`,
      `create index challenges_challenger on challenges(challenger_id, created_at desc)`,
      `create index challenges_opponent on challenges(opponent_id, created_at desc)`,
      `create unique index challenges_open_pair on challenges(least(challenger_id, opponent_id), greatest(challenger_id, opponent_id), game) where status in ('pending','accepted','reported','disputed')`,
      `create table quick_queue (
        user_id uuid primary key references users(id) on delete cascade,
        game text not null,
        joined_at timestamptz not null default now(),
        expires_at timestamptz not null
      )`,
      `create index quick_queue_game on quick_queue(game, joined_at)`,
      `create table media (
        id uuid primary key default gen_random_uuid(),
        owner_id uuid references users(id) on delete set null,
        kind text not null check (kind in ('team_logo','team_banner','tournament_banner','evidence','sponsor_logo')),
        content_type text not null check (content_type in ('image/png','image/jpeg','image/webp')),
        bytes int not null check (bytes > 0 and bytes <= 2097152),
        sha256 text not null,
        data bytea not null,
        created_at timestamptz not null default now()
      )`,
      `create index media_owner on media(owner_id, created_at desc)`,
      `alter table teams add column logo_media_id uuid references media(id) on delete set null`,
      `alter table teams add column banner_media_id uuid references media(id) on delete set null`,
      `alter table tournaments add column banner_media_id uuid references media(id) on delete set null`,
      `alter table disputes add column evidence_media_id uuid references media(id) on delete set null`,
      `create table sponsors (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        tier text not null check (tier in ('title','gold','silver','partner')),
        website_url text not null default '',
        logo_media_id uuid references media(id) on delete set null,
        active boolean not null default true,
        created_by uuid references users(id),
        created_at timestamptz not null default now()
      )`,
      `create table tournament_sponsors (
        tournament_id uuid not null references tournaments(id) on delete cascade,
        sponsor_id uuid not null references sponsors(id) on delete cascade,
        primary key (tournament_id, sponsor_id)
      )`,
    ],
  },
  {
    id: 4,
    name: "accounts_email_consents_mfa",
    statements: [
      `alter table users drop constraint if exists users_status_check`,
      `alter table users add constraint users_status_check check (status in ('active','suspended','deleted','pending'))`,
      `alter table users add column email_verified_at timestamptz`,
      `alter table users add column marketing_opt_in_at timestamptz`,
      `create table email_tokens (
        id text primary key,
        user_id uuid not null references users(id) on delete cascade,
        purpose text not null check (purpose in ('verify_email','reset_password','activate')),
        email text not null,
        expires_at timestamptz not null,
        used_at timestamptz,
        created_at timestamptz not null default now()
      )`,
      `create index email_tokens_user on email_tokens(user_id, purpose, created_at desc)`,
      `create table email_outbox (
        id uuid primary key default gen_random_uuid(),
        to_email text not null,
        template text not null,
        lang text not null,
        data jsonb not null default '{}',
        status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
        attempts int not null default 0,
        next_attempt_at timestamptz not null default now(),
        locked_until timestamptz,
        last_error text not null default '',
        provider text not null default '',
        provider_message_id text not null default '',
        dedupe_key text unique,
        user_id uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        sent_at timestamptz
      )`,
      `create index email_outbox_due on email_outbox(status, next_attempt_at)`,
      `create table consents (
        id bigserial primary key,
        user_id uuid not null references users(id) on delete cascade,
        kind text not null check (kind in ('terms','privacy','marketing','membership_terms')),
        version text not null,
        granted boolean not null,
        source text not null,
        created_at timestamptz not null default now()
      )`,
      `create index consents_user on consents(user_id, kind, id desc)`,
      // Existing accounts accepted the 27 September 2026 terms and privacy notice at sign-up (required checkbox).
      `insert into consents (user_id, kind, version, granted, source, created_at)
         select id, 'terms', '2026-09-27', true, 'signup_checkbox', created_at from users where status <> 'deleted'`,
      `insert into consents (user_id, kind, version, granted, source, created_at)
         select id, 'privacy', '2026-09-27', true, 'signup_checkbox', created_at from users where status <> 'deleted'`,
      `alter table sessions add column mfa_at timestamptz`,
      `create table mfa_factors (
        user_id uuid primary key references users(id) on delete cascade,
        secret text not null,
        scheme text not null check (scheme in ('aes-256-gcm','plain')),
        confirmed_at timestamptz,
        last_step bigint not null default 0,
        created_at timestamptz not null default now()
      )`,
      `create table mfa_recovery_codes (
        user_id uuid not null references users(id) on delete cascade,
        code_hash text not null,
        used_at timestamptz,
        primary key (user_id, code_hash)
      )`,
    ],
  },
  {
    id: 5,
    name: "billing_offers_memberships",
    statements: [
      `create table offers (
        id uuid primary key default gen_random_uuid(),
        code text not null,
        version int not null,
        kind text not null check (kind in ('membership','pass_premium')),
        status text not null default 'proposed' check (status in ('proposed','active','retired')),
        title jsonb not null,
        benefits jsonb not null,
        exclusions jsonb not null,
        audience text not null default 'adult_account_holders',
        legal_recipient text not null,
        price_minor bigint check (price_minor > 0),
        currency text check (currency ~ '^[A-Z]{3}$'),
        exponent int check (exponent between 0 and 3),
        tax_treatment text,
        duration_days int check (duration_days between 1 and 1100),
        admission text not null default 'review' check (admission in ('review','self_service')),
        terms_text jsonb,
        refund_text jsonb,
        approval_ref text,
        approved_by uuid references users(id),
        approved_at timestamptz,
        created_by uuid references users(id),
        created_at timestamptz not null default now(),
        unique (code, version)
      )`,
      `create unique index offers_one_active on offers(code) where status = 'active'`,
      `create sequence membership_ref_seq`,
      `create table membership_applications (
        id uuid primary key default gen_random_uuid(),
        reference text not null unique,
        user_id uuid not null references users(id),
        offer_id uuid not null references offers(id),
        status text not null default 'submitted' check (status in ('submitted','under_review','awaiting_info','approved','declined','withdrawn')),
        objective text not null default '',
        lang text not null default 'ru' check (lang in ('ru','en')),
        decision_note text not null default '',
        decided_by uuid references users(id),
        decided_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create unique index membership_applications_open on membership_applications(user_id, offer_id) where status in ('submitted','under_review','awaiting_info')`,
      `create sequence invoice_number_seq`,
      `create table invoices (
        id uuid primary key default gen_random_uuid(),
        number text not null unique,
        user_id uuid not null references users(id),
        application_id uuid references membership_applications(id),
        offer_id uuid not null references offers(id),
        offer_snapshot jsonb not null,
        recipient text not null,
        amount_minor bigint not null check (amount_minor > 0),
        currency text not null check (currency ~ '^[A-Z]{3}$'),
        exponent int not null check (exponent between 0 and 3),
        tax_treatment text not null,
        terms_version text not null,
        lang text not null default 'ru' check (lang in ('ru','en')),
        status text not null default 'open' check (status in ('open','paid','void','refunded','partially_refunded','disputed')),
        refunded_minor bigint not null default 0 check (refunded_minor >= 0),
        issued_by uuid references users(id),
        created_at timestamptz not null default now(),
        paid_at timestamptz,
        voided_at timestamptz
      )`,
      `create unique index invoices_open_application on invoices(application_id) where status = 'open'`,
      `create index invoices_user on invoices(user_id, created_at desc)`,
      `create table payment_attempts (
        id uuid primary key default gen_random_uuid(),
        invoice_id uuid not null references invoices(id),
        user_id uuid not null references users(id),
        provider text not null,
        mode text not null check (mode in ('test','live')),
        provider_session_id text unique,
        provider_payment_id text,
        status text not null default 'created' check (status in ('created','open','processing','succeeded','failed','expired','canceled')),
        amount_minor bigint not null,
        currency text not null,
        idem_key text not null unique,
        terms_version text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        expires_at timestamptz
      )`,
      `create unique index payment_attempts_active on payment_attempts(invoice_id) where status in ('created','open','processing')`,
      `create table provider_events (
        id text primary key,
        provider text not null,
        type text not null,
        livemode boolean not null,
        status text not null check (status in ('received','processed','ignored','failed')),
        error text not null default '',
        invoice_id uuid references invoices(id),
        payload_sha256 text not null,
        provider_created_at timestamptz,
        received_at timestamptz not null default now(),
        processed_at timestamptz
      )`,
      `create table ledger_entries (
        id bigserial primary key,
        invoice_id uuid not null references invoices(id),
        payment_attempt_id uuid references payment_attempts(id),
        kind text not null check (kind in ('charge','refund','dispute','dispute_reversal')),
        amount_minor bigint not null,
        currency text not null,
        provider_ref text not null,
        created_at timestamptz not null default now(),
        unique (kind, provider_ref)
      )`,
      `create table memberships (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id),
        offer_id uuid not null references offers(id),
        application_id uuid references membership_applications(id),
        invoice_id uuid unique references invoices(id),
        status text not null default 'pending' check (status in ('pending','active','suspended','expired','ended')),
        starts_at timestamptz,
        ends_at timestamptz,
        status_reason text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index memberships_user on memberships(user_id, status)`,
      // A proposed (not payable) membership structure. Commercial terms are NOT PROVIDED: stored as null.
      `insert into offers (code, version, kind, status, title, benefits, exclusions, legal_recipient)
       values ('vegas-membership', 1, 'membership', 'proposed',
         '{"ru":"Членство MAXIMUS VEGAS","en":"MAXIMUS VEGAS membership"}',
         '{"ru":["Премиальная линия сезонного пропуска","Знак участника и эксклюзивный цвет аватара в профиле"],"en":["Premium track of the season pass","Member badge and an exclusive avatar colour on your profile"]}',
         '{"ru":["Никакого преимущества в соревновании: посев, результаты, рейтинги и доступ к турнирам одинаковы для всех","Монеты, деньги и призы не начисляются"],"en":["No competitive advantage: seeding, results, rankings and tournament access are the same for everyone","No coins, cash or prizes are credited"]}',
         'MAXIMUS VEGAS L.L.C-FZ')`,
    ],
  },
  {
    id: 6,
    name: "round_robin_swiss_circuits",
    statements: [
      // Round robin and Swiss. Constraint changes only widen what is allowed; release 2 code keeps working.
      // Every existing check on the column is dropped by definition, not by an assumed name, so an
      // older narrower check can never survive next to the new one.
      `do $$ declare r record; begin
         for r in select conname from pg_constraint
                   where conrelid = 'tournaments'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%format%' loop
           execute format('alter table tournaments drop constraint %I', r.conname);
         end loop;
         for r in select conname from pg_constraint
                   where conrelid = 'matches'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%bracket%' loop
           execute format('alter table matches drop constraint %I', r.conname);
         end loop;
       end $$`,
      `alter table tournaments add constraint tournaments_format_check check (format in ('single_elimination','double_elimination','leaderboard','round_robin','swiss'))`,
      `alter table tournaments add column format_settings jsonb`,
      `alter table matches add constraint matches_bracket_check check (bracket in ('W','L','GF','RR','SW'))`,
      // A draw has no winner. Only round robin and Swiss accept draws, and only when the organiser allows them.
      `alter table match_results alter column winner_reg drop not null`,
      // Circuits: a season of linked tournaments with cumulative points, qualification and divisions.
      `create table circuits (
        id uuid primary key default gen_random_uuid(),
        slug text not null unique,
        org_id uuid not null references organizations(id),
        name text not null,
        season text not null,
        game text not null,
        participant_type text not null check (participant_type in ('solo','team')),
        description text not null default '',
        points_table int[] not null,
        participation_points int not null default 0 check (participation_points between 0 and 1000),
        qualify_top int not null default 0 check (qualify_top between 0 and 256),
        divisions int not null default 1 check (divisions between 1 and 5),
        promote int not null default 0 check (promote between 0 and 64),
        relegate int not null default 0 check (relegate between 0 and 64),
        status text not null default 'active' check (status in ('active','closed')),
        rules_version text not null default 'MV-CIRCUIT-1',
        previous_id uuid references circuits(id),
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        closed_at timestamptz
      )`,
      `create unique index circuits_next_season on circuits(previous_id) where previous_id is not null`,
      `create index circuits_org on circuits(org_id, created_at desc)`,
      `create table circuit_members (
        circuit_id uuid not null references circuits(id) on delete cascade,
        division int not null check (division between 1 and 5),
        user_id uuid references users(id),
        team_id uuid references teams(id),
        source text not null default 'assigned' check (source in ('assigned','promoted','relegated','stayed')),
        added_by uuid references users(id),
        added_at timestamptz not null default now(),
        check ((user_id is null) <> (team_id is null))
      )`,
      `create unique index circuit_members_user on circuit_members(circuit_id, user_id) where user_id is not null`,
      `create unique index circuit_members_team on circuit_members(circuit_id, team_id) where team_id is not null`,
      // The frozen table of a closed season: never recomputed, so history stays exactly as published.
      `create table circuit_results (
        circuit_id uuid not null references circuits(id) on delete cascade,
        division int not null,
        rank int not null,
        user_id uuid references users(id),
        team_id uuid references teams(id),
        name text not null,
        points int not null,
        events int not null,
        titles int not null,
        best int,
        member boolean not null default false,
        qualified boolean not null default false,
        movement text check (movement in ('promoted','relegated','stayed')),
        primary key (circuit_id, division, rank)
      )`,
      `create index circuit_results_user on circuit_results(user_id) where user_id is not null`,
      `create index circuit_results_team on circuit_results(team_id) where team_id is not null`,
      `alter table tournaments add column circuit_id uuid references circuits(id)`,
      `alter table tournaments add column circuit_division int check (circuit_division between 1 and 5)`,
      `alter table tournaments add column circuit_weight int not null default 100 check (circuit_weight between 10 and 1000)`,
      `alter table tournaments add column qualifier_circuit_id uuid references circuits(id)`,
      `create index tournaments_circuit on tournaments(circuit_id) where circuit_id is not null`,
    ],
  },
  {
    id: 7,
    name: "stages_groups_gauntlet",
    statements: [
      // Groups and gauntlet formats; a main stage (1) and a playoff (2). Checks are replaced by definition.
      `do $$ declare r record; begin
         for r in select conname from pg_constraint
                   where conrelid = 'tournaments'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%format%' loop
           execute format('alter table tournaments drop constraint %I', r.conname);
         end loop;
         for r in select conname from pg_constraint
                   where conrelid = 'matches'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%bracket%' loop
           execute format('alter table matches drop constraint %I', r.conname);
         end loop;
       end $$`,
      `alter table tournaments add constraint tournaments_format_check check (format in ('single_elimination','double_elimination','leaderboard','round_robin','swiss','groups','gauntlet'))`,
      `alter table matches add constraint matches_bracket_check check (bracket in ('W','L','GF','RR','SW','G'))`,
      `alter table tournaments add column stage int not null default 1 check (stage between 1 and 2)`,
      `alter table matches add column stage int not null default 1 check (stage between 1 and 2)`,
      // The slot key (tournament, bracket, round, position) stays as it is, so release 3 code keeps working:
      // group matches of one round take consecutive positions across groups; playoff brackets (W/L/GF/G)
      // never share a bracket code with the main stage (RR/SW).
      `alter table matches add column group_no int not null default 0 check (group_no between 0 and 32)`,
      `alter table registrations add column group_no int check (group_no between 1 and 32)`,
      // Who entered the playoff, with the seed and the main-stage result that earned it: kept for audit and places.
      `create table stage_entries (
        tournament_id uuid not null references tournaments(id) on delete cascade,
        stage int not null check (stage = 2),
        registration_id uuid not null references registrations(id) on delete cascade,
        seed int not null check (seed >= 1),
        group_no int,
        source_rank int not null,
        created_at timestamptz not null default now(),
        primary key (tournament_id, stage, registration_id)
      )`,
      `create unique index stage_entries_seed on stage_entries(tournament_id, stage, seed)`,
    ],
  },
  {
    id: 8,
    name: "registration_rosters_templates_ffa",
    statements: [
      // FFA lobbies join the formats; registrations gain approval ("pending", "rejected"). Checks are replaced by definition.
      `do $$ declare r record; begin
         for r in select conname from pg_constraint
                   where conrelid = 'tournaments'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%format%' loop
           execute format('alter table tournaments drop constraint %I', r.conname);
         end loop;
         for r in select conname from pg_constraint
                   where conrelid = 'registrations'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%withdrawn%' loop
           execute format('alter table registrations drop constraint %I', r.conname);
         end loop;
       end $$`,
      `alter table tournaments add constraint tournaments_format_check check (format in ('single_elimination','double_elimination','leaderboard','round_robin','swiss','groups','gauntlet','ffa'))`,
      `alter table registrations add constraint registrations_status_check check (status in ('registered','waitlisted','withdrawn','disqualified','not_checked_in','pending','rejected'))`,
      // A rejected application frees the entrant to apply again, like a withdrawal.
      `drop index if exists registrations_user`,
      `drop index if exists registrations_team`,
      `create unique index registrations_user on registrations(tournament_id, user_id) where user_id is not null and status not in ('withdrawn','rejected')`,
      `create unique index registrations_team on registrations(tournament_id, team_id) where team_id is not null and status not in ('withdrawn','rejected')`,
      `alter table registrations add column answers jsonb`,
      `alter table registrations add column decision_note text not null default ''`,
      `alter table registrations add column decided_by uuid references users(id)`,
      `alter table registrations add column decided_at timestamptz`,
      `alter table tournaments add column registration_fields jsonb`,
      `alter table tournaments add column approval_required boolean not null default false`,
      `alter table tournaments add column registration_closes_at timestamptz`,
      `alter table tournaments add column roster_locks_at timestamptz`,
      `alter table tournaments add column no_show_minutes int check (no_show_minutes between 0 and 240)`,
      // Every change of an event roster, before the lock (edit) and after it (substitution).
      `create table roster_changes (
        id bigserial primary key,
        tournament_id uuid not null references tournaments(id) on delete cascade,
        registration_id uuid not null references registrations(id) on delete cascade,
        kind text not null check (kind in ('edit','substitution')),
        user_out uuid references users(id),
        user_in uuid references users(id),
        reason text not null default '',
        changed_by uuid not null references users(id),
        created_at timestamptz not null default now()
      )`,
      `create index roster_changes_registration on roster_changes(registration_id, created_at)`,
      `create table tournament_templates (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references organizations(id) on delete cascade,
        name text not null,
        category text not null default '',
        payload jsonb not null,
        source_tournament_id uuid references tournaments(id) on delete set null,
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        uses int not null default 0 check (uses >= 0)
      )`,
      `create unique index tournament_templates_name on tournament_templates(org_id, lower(name))`,
      `alter table tournaments add column template_id uuid references tournament_templates(id) on delete set null`,
      // FFA: lobbies per round, their entrants and games; one current result per entrant and game, every version kept.
      `create table ffa_lobbies (
        id uuid primary key default gen_random_uuid(),
        tournament_id uuid not null references tournaments(id) on delete cascade,
        round int not null check (round between 1 and 20),
        lobby_no int not null check (lobby_no between 1 and 256),
        status text not null default 'open' check (status in ('open','completed')),
        room_code text not null default '',
        scheduled_at timestamptz,
        created_at timestamptz not null default now(),
        unique (tournament_id, round, lobby_no)
      )`,
      `create table ffa_entries (
        lobby_id uuid not null references ffa_lobbies(id) on delete cascade,
        tournament_id uuid not null references tournaments(id) on delete cascade,
        round int not null,
        registration_id uuid not null references registrations(id) on delete cascade,
        seed int not null check (seed >= 1),
        primary key (lobby_id, registration_id),
        unique (tournament_id, round, registration_id)
      )`,
      `create table ffa_games (
        id uuid primary key default gen_random_uuid(),
        lobby_id uuid not null references ffa_lobbies(id) on delete cascade,
        tournament_id uuid not null references tournaments(id) on delete cascade,
        game_no int not null check (game_no between 1 and 12),
        status text not null default 'scheduled' check (status in ('scheduled','completed')),
        version int not null default 0,
        evidence_url text not null default '',
        decided_by uuid references users(id),
        completed_at timestamptz,
        unique (lobby_id, game_no)
      )`,
      `create table ffa_results (
        game_id uuid not null references ffa_games(id) on delete cascade,
        registration_id uuid not null references registrations(id) on delete cascade,
        placement int not null check (placement between 1 and 256),
        kills int not null default 0 check (kills between 0 and 999),
        primary key (game_id, registration_id),
        unique (game_id, placement)
      )`,
      `create table ffa_result_versions (
        game_id uuid not null references ffa_games(id) on delete cascade,
        version int not null check (version >= 1),
        results jsonb not null,
        note text not null default '',
        evidence_url text not null default '',
        decided_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        primary key (game_id, version)
      )`,
      `create table ffa_disputes (
        id uuid primary key default gen_random_uuid(),
        game_id uuid not null references ffa_games(id) on delete cascade,
        opened_by uuid not null references users(id),
        reason text not null,
        evidence_url text not null default '',
        status text not null default 'open' check (status in ('open','resolved')),
        decision text check (decision in ('upheld','corrected')),
        resolution text not null default '',
        resolved_by uuid references users(id),
        created_at timestamptz not null default now(),
        resolved_at timestamptz
      )`,
      `create unique index ffa_disputes_open on ffa_disputes(game_id, opened_by) where status = 'open'`,
      `create index ffa_entries_registration on ffa_entries(registration_id)`,
    ],
  },
  {
    id: 9,
    name: "series_venues_admission_feedback",
    statements: [
      // Series length and points by level (MV-SERIES-1); a referee's override of one match.
      `alter table tournaments add column series_rules jsonb`,
      `alter table matches add column series_override int check (series_override in (1,3,5,7))`,
      `alter table matches add column points_override jsonb`,
      // Admission criteria every player of an entry must meet.
      `alter table tournaments add column admission jsonb`,
      // Venues (stages, stations, servers) and the expected match length for the schedule (MV-SCHEDULE-1).
      `alter table tournaments add column match_minutes int check (match_minutes between 10 and 600)`,
      `create table tournament_venues (
        id uuid primary key default gen_random_uuid(),
        tournament_id uuid not null references tournaments(id) on delete cascade,
        name text not null,
        kind text not null default 'station' check (kind in ('stage','station','server','table','room','other')),
        created_at timestamptz not null default now()
      )`,
      `create unique index tournament_venues_name on tournament_venues(tournament_id, lower(name))`,
      `alter table matches add column venue_id uuid references tournament_venues(id) on delete set null`,
      `create index matches_open_scheduled on matches(scheduled_at) where scheduled_at is not null and status not in ('completed','cancelled')`,
      // One rating per participant and finished tournament; comments are seen by its organisers only.
      `create table tournament_feedback (
        tournament_id uuid not null references tournaments(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        rating int not null check (rating between 1 and 5),
        comment text not null default '',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (tournament_id, user_id)
      )`,
    ],
  },
  {
    id: 10,
    name: "game_day_referee_calls",
    statements: [
      // Requests for staff attention during an event. Release scope: a participant's call to the referee
      // for a match, one open call per side, closed by staff with a reply. The live-operations queue extends it.
      `create table incidents (
        id uuid primary key default gen_random_uuid(),
        tournament_id uuid not null references tournaments(id) on delete cascade,
        match_id uuid references matches(id) on delete cascade,
        kind text not null check (kind in ('referee_call')),
        side text check (side in ('a','b')),
        opened_by uuid not null references users(id),
        message text not null check (char_length(message) between 3 and 500),
        status text not null default 'open' check (status in ('open','resolved')),
        resolution text not null default '',
        resolved_by uuid references users(id),
        created_at timestamptz not null default now(),
        resolved_at timestamptz
      )`,
      `create unique index incidents_one_open_call on incidents(match_id, side) where kind = 'referee_call' and status = 'open'`,
      `create index incidents_open_by_tournament on incidents(tournament_id, created_at) where status = 'open'`,
    ],
  },
  {
    id: 11,
    name: "live_operations",
    statements: [
      // The incident queue: staff-reported kinds, priority, an assignee and escalation to the space's owners.
      `alter table incidents drop constraint incidents_kind_check`,
      `alter table incidents add constraint incidents_kind_check check (kind in ('referee_call','technical','conduct','no_show','schedule','other'))`,
      `alter table incidents add column priority text not null default 'normal' check (priority in ('low','normal','high','urgent'))`,
      `alter table incidents add column assigned_to uuid references users(id)`,
      `alter table incidents add column assigned_at timestamptz`,
      `alter table incidents add column escalated_at timestamptz`,
      `alter table incidents add column escalation_note text not null default ''`,
      // A referee may pause one match: results, confirmations, check-ins and no-shows wait until it resumes.
      `alter table matches add column paused_at timestamptz`,
      `alter table matches add column pause_reason text not null default ''`,
    ],
  },
  {
    id: 12,
    name: "map_veto",
    statements: [
      // Map pool of the event (MV-VETO-1); no pool means no veto.
      `alter table tournaments add column map_pool jsonb`,
      // One row per veto turn: who banned or picked which map. A map is taken once per match.
      `create table match_vetoes (
        match_id uuid not null references matches(id) on delete cascade,
        step int not null check (step between 1 and 30),
        side text not null check (side in ('a','b')),
        action text not null check (action in ('ban','pick')),
        map text not null,
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        primary key (match_id, step),
        unique (match_id, map)
      )`,
    ],
  },
  {
    id: 13,
    name: "team_finder",
    statements: [
      // Team finder: players looking for a team (lft) or a group (lfg), and teams' roster vacancies.
      `create table finder_posts (
        id uuid primary key default gen_random_uuid(),
        kind text not null check (kind in ('lft','lfg','vacancy')),
        user_id uuid not null references users(id) on delete cascade,
        team_id uuid references teams(id) on delete cascade,
        game text not null,
        region text not null default '',
        roles text not null default '',
        languages text not null default '',
        level text not null default '',
        schedule text not null default '',
        note text not null default '' check (char_length(note) <= 500),
        slots int not null default 1 check (slots between 1 and 5),
        status text not null default 'open' check (status in ('open','closed')),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        closed_at timestamptz,
        check ((kind = 'vacancy') = (team_id is not null))
      )`,
      `create index finder_posts_open on finder_posts(kind, game, created_at desc) where status = 'open'`,
      `create unique index finder_one_open_post on finder_posts(user_id, kind, game) where status = 'open' and kind in ('lft','lfg')`,
      `create table finder_applications (
        id uuid primary key default gen_random_uuid(),
        post_id uuid not null references finder_posts(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        message text not null default '' check (char_length(message) <= 500),
        status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn')),
        decided_by uuid references users(id),
        created_at timestamptz not null default now(),
        decided_at timestamptz
      )`,
      `create unique index finder_one_pending on finder_applications(post_id, user_id) where status = 'pending'`,
    ],
  },
  {
    id: 14,
    name: "parties_ready_check_rating",
    statements: [
      // Parties: a leader and up to four more players of one game; a player is in one party at a time.
      `create table parties (
        id uuid primary key default gen_random_uuid(),
        leader_id uuid not null references users(id) on delete cascade,
        game text not null,
        created_at timestamptz not null default now()
      )`,
      `create table party_members (
        party_id uuid not null references parties(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        joined_at timestamptz not null default now(),
        primary key (party_id, user_id)
      )`,
      `create unique index party_members_one_party on party_members(user_id)`,
      `create table party_invites (
        id uuid primary key default gen_random_uuid(),
        party_id uuid not null references parties(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        invited_by uuid not null references users(id),
        status text not null default 'pending' check (status in ('pending','accepted','declined','revoked')),
        created_at timestamptz not null default now(),
        responded_at timestamptz
      )`,
      `create unique index party_invites_pending on party_invites(party_id, user_id) where status = 'pending'`,
      // Ready check: every player of a found match confirms before the match exists.
      `create table ready_checks (
        id uuid primary key default gen_random_uuid(),
        game text not null,
        size int not null check (size between 1 and 5),
        status text not null default 'pending' check (status in ('pending','passed','failed')),
        reasons jsonb not null default '{}',
        challenge_id uuid references challenges(id),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        settled_at timestamptz
      )`,
      `create index ready_checks_pending on ready_checks(game, expires_at) where status = 'pending'`,
      `create table ready_check_players (
        ready_check_id uuid not null references ready_checks(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        side text not null check (side in ('a','b')),
        party_id uuid,
        queued_at timestamptz not null,
        region text not null default '',
        answer text check (answer in ('ready','declined')),
        answered_at timestamptz,
        primary key (ready_check_id, user_id)
      )`,
      `create index ready_check_players_user on ready_check_players(user_id)`,
      `alter table quick_queue add column party_id uuid references parties(id) on delete cascade`,
      `alter table quick_queue add column region text not null default ''`,
      `alter table quick_queue add column held_by uuid references ready_checks(id) on delete set null`,
      // Players of each side of a quick match (party matches have several per side).
      `create table challenge_members (
        challenge_id uuid not null references challenges(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        side text not null check (side in ('a','b')),
        primary key (challenge_id, user_id)
      )`,
      `create index challenge_members_user on challenge_members(user_id)`,
      // A declined or missed ready check: a queue cooldown that grows with repeats.
      `create table quick_dodges (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        game text not null,
        ready_check_id uuid references ready_checks(id) on delete set null,
        kind text not null check (kind in ('declined','missed')),
        cooldown_until timestamptz not null,
        created_at timestamptz not null default now()
      )`,
      `create index quick_dodges_user on quick_dodges(user_id, created_at desc)`,
      // Quick-match rating per game (MV-RATING-1) and every change of it.
      `create table ratings (
        user_id uuid not null references users(id) on delete cascade,
        game text not null,
        rating int not null default 1000 check (rating >= 100),
        matches int not null default 0,
        wins int not null default 0,
        losses int not null default 0,
        peak int not null default 1000,
        updated_at timestamptz not null default now(),
        primary key (user_id, game)
      )`,
      `create index ratings_game on ratings(game, rating desc)`,
      `create table rating_events (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        game text not null,
        challenge_id uuid not null references challenges(id),
        result text not null check (result in ('win','loss')),
        before int not null,
        after int not null,
        delta int not null,
        created_at timestamptz not null default now(),
        unique (user_id, challenge_id)
      )`,
      `create index rating_events_user on rating_events(user_id, game, created_at desc)`,
    ],
  },
  {
    id: 15,
    name: "conduct_sanctions_appeals",
    statements: [
      // Fair-play rules, versioned: a sanction cites the exact version it applied.
      `create table conduct_rules (
        code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
        version int not null check (version >= 1),
        title_ru text not null,
        title_en text not null,
        body_ru text not null,
        body_en text not null,
        source_ru text not null default '',
        source_en text not null default '',
        created_by uuid references users(id),
        created_at timestamptz not null default now(),
        retired_at timestamptz,
        primary key (code, version)
      )`,
      `create unique index conduct_rules_current on conduct_rules(code) where retired_at is null`,
      // The first rules restate the prohibitions of the Terms of use, version 2026-09-27.2.
      `insert into conduct_rules (code, version, title_ru, title_en, body_ru, body_en, source_ru, source_en) values
        ('CHEATING', 1, 'Читы и эксплойты', 'Cheats and exploits', 'Запрещены читы и эксплойты.', 'Cheats and exploits are prohibited.',
         'Условия использования, редакция 2026-09-27.2, раздел 5', 'Terms of use, version 2026-09-27.2, section 5'),
        ('MATCH_FIXING', 1, 'Договорные матчи', 'Match fixing', 'Запрещены договорные матчи.', 'Match fixing is prohibited.',
         'Условия использования, редакция 2026-09-27.2, раздел 5', 'Terms of use, version 2026-09-27.2, section 5'),
        ('ACCOUNTS', 1, 'Чужие и подставные аккаунты', 'Other people''s and smurf accounts',
         'Один человек — один аккаунт; передача аккаунта другому лицу запрещена. Запрещены игра за чужой аккаунт и подставные аккаунты.',
         'One person, one account; transferring an account to someone else is prohibited. Playing on someone else''s account and smurf accounts are prohibited.',
         'Условия использования, редакция 2026-09-27.2, разделы 2 и 5', 'Terms of use, version 2026-09-27.2, sections 2 and 5'),
        ('PRESSURE', 1, 'Давление на соперников и судей', 'Pressure on opponents or referees', 'Запрещено давление на соперников или судей.', 'Pressure on opponents or referees is prohibited.',
         'Условия использования, редакция 2026-09-27.2, раздел 5', 'Terms of use, version 2026-09-27.2, section 5'),
        ('CONTENT', 1, 'Недопустимый контент', 'Prohibited content', 'Запрещены незаконные материалы, оскорбления, дискриминация и нарушение чужих прав.',
         'Illegal material, abuse, discrimination and infringement of others'' rights are prohibited.',
         'Условия использования, редакция 2026-09-27.2, раздел 9', 'Terms of use, version 2026-09-27.2, section 9'),
        ('STAKES', 1, 'Ставки и игры на деньги', 'Betting and real-money play',
         'На портале не допускаются ставки, пари, ставки монетами, лотереи, игры на деньги, платные прогнозы, платные случайные награды и призовые фонды из взносов участников.',
         'The portal does not allow betting, wagering, coin stakes, lotteries, real-money games, paid predictions, paid random rewards or prize pools funded by participant fees.',
         'Условия использования, редакция 2026-09-27.2, раздел 3', 'Terms of use, version 2026-09-27.2, section 3')`,
      // A player's report about another player.
      `create table conduct_reports (
        id uuid primary key default gen_random_uuid(),
        reporter_id uuid not null references users(id),
        subject_id uuid not null references users(id),
        rule_code text not null,
        context_url text not null default '',
        description text not null check (char_length(description) between 20 and 2000),
        evidence_url text not null default '',
        status text not null default 'open' check (status in ('open','reviewing','actioned','dismissed')),
        assigned_to uuid references users(id),
        resolution text not null default '',
        resolved_by uuid references users(id),
        created_at timestamptz not null default now(),
        resolved_at timestamptz,
        check (reporter_id <> subject_id)
      )`,
      `create index conduct_reports_open on conduct_reports(created_at) where status in ('open','reviewing')`,
      `create unique index conduct_reports_one_open on conduct_reports(reporter_id, subject_id) where status in ('open','reviewing')`,
      `create index conduct_reports_reporter on conduct_reports(reporter_id, created_at desc)`,
      // A sanction: rule version, evidence with its digest, confidence, decision, term; revoked rather than deleted.
      `create table sanctions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id),
        kind text not null check (kind in ('warning','queue_ban','tournament_ban','suspension')),
        protective boolean not null default false,
        rule_code text not null,
        rule_version int not null,
        confidence text not null check (confidence in ('low','medium','high')),
        evidence jsonb not null,
        evidence_hash text not null,
        decision text not null check (char_length(decision) between 20 and 2000),
        report_id uuid references conduct_reports(id),
        issued_by uuid not null references users(id),
        starts_at timestamptz not null default now(),
        ends_at timestamptz,
        revoked_at timestamptz,
        revoked_by uuid references users(id),
        revoke_reason text not null default '',
        created_at timestamptz not null default now(),
        foreign key (rule_code, rule_version) references conduct_rules(code, version),
        check (ends_at is null or ends_at > starts_at),
        check (not protective or (kind = 'suspension' and ends_at is not null))
      )`,
      `create index sanctions_user on sanctions(user_id, created_at desc)`,
      `create index sanctions_live on sanctions(user_id, kind) where revoked_at is null`,
      // One appeal per sanction, decided by a staff member other than the issuer.
      `create table sanction_appeals (
        id uuid primary key default gen_random_uuid(),
        sanction_id uuid not null references sanctions(id),
        user_id uuid not null references users(id),
        statement text not null check (char_length(statement) between 20 and 2000),
        evidence_url text not null default '',
        status text not null default 'open' check (status in ('open','upheld','granted')),
        decided_by uuid references users(id),
        decision text not null default '',
        created_at timestamptz not null default now(),
        decided_at timestamptz
      )`,
      `create unique index sanction_appeals_one on sanction_appeals(sanction_id)`,
      `create index sanction_appeals_open on sanction_appeals(created_at) where status = 'open'`,
    ],
  },
  {
    id: 16,
    name: "scouting",
    statements: [
      // Scouting over public profiles: a player's saved search filters and watchlist (both private to them).
      `create table scout_filters (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        name text not null check (char_length(name) between 2 and 60),
        query jsonb not null,
        created_at timestamptz not null default now()
      )`,
      `create unique index scout_filters_name on scout_filters(user_id, lower(name))`,
      `create table scout_watch (
        user_id uuid not null references users(id) on delete cascade,
        player_id uuid not null references users(id) on delete cascade,
        note text not null default '' check (char_length(note) <= 200),
        created_at timestamptz not null default now(),
        primary key (user_id, player_id),
        check (user_id <> player_id)
      )`,
      `create index scout_watch_player on scout_watch(player_id)`,
    ],
  },
  {
    id: 17,
    name: "transfers_roster_history",
    statements: [
      // Roster history of every team: written by a trigger on team_members, so no path can skip it.
      `create table team_history (
        id bigserial primary key,
        team_id uuid not null references teams(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        event text not null check (event in ('joined','left','removed','transferred_in','transferred_out','returned_in','returned_out')),
        transfer_id uuid,
        at timestamptz not null default now()
      )`,
      `create index team_history_team on team_history(team_id, at desc, id desc)`,
      `create index team_history_user on team_history(user_id, at desc, id desc)`,
      `insert into team_history (team_id, user_id, event, at) select team_id, user_id, 'joined', joined_at from team_members`,
      // The reason travels in a transaction-local setting: "removed", "transfer:<id>" or "return:<id>".
      `create function team_history_record() returns trigger language plpgsql as $fn$
       declare
         reason text := coalesce(current_setting('mv.membership', true), '');
         tid uuid := case when reason ~ '^(transfer|return):[0-9a-f-]{36}$' then split_part(reason, ':', 2)::uuid end;
       begin
         if tg_op = 'INSERT' then
           insert into team_history (team_id, user_id, event, transfer_id)
           values (new.team_id, new.user_id,
                   case when reason like 'transfer:%' then 'transferred_in' when reason like 'return:%' then 'returned_in' else 'joined' end, tid);
           return new;
         end if;
         -- A team being deleted takes its history with it.
         if not exists (select 1 from teams where id = old.team_id) then
           return old;
         end if;
         insert into team_history (team_id, user_id, event, transfer_id)
         values (old.team_id, old.user_id,
                 case when reason like 'transfer:%' then 'transferred_out' when reason like 'return:%' then 'returned_out'
                      when reason = 'removed' then 'removed' else 'left' end, tid);
         return old;
       end $fn$`,
      `create trigger team_members_history after insert or delete on team_members for each row execute function team_history_record()`,
      // A transfer: proposed by the receiving team, agreed by the player and the releasing team.
      `create table team_transfers (
        id uuid primary key default gen_random_uuid(),
        player_id uuid not null references users(id),
        from_team uuid not null references teams(id) on delete cascade,
        to_team uuid not null references teams(id) on delete cascade,
        proposed_by uuid not null references users(id),
        note text not null default '' check (char_length(note) <= 300),
        player_ok_at timestamptz,
        from_ok_at timestamptz,
        from_ok_by uuid references users(id),
        status text not null default 'proposed' check (status in ('proposed','completed','declined','cancelled','expired','reversed')),
        declined_by uuid references users(id),
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        completed_at timestamptz,
        check (from_team <> to_team)
      )`,
      `create unique index team_transfers_open on team_transfers(player_id, to_team) where status = 'proposed'`,
      `create index team_transfers_teams on team_transfers(from_team, to_team, created_at desc)`,
      `create table transfer_disputes (
        id uuid primary key default gen_random_uuid(),
        transfer_id uuid not null references team_transfers(id) on delete cascade,
        opened_by uuid not null references users(id),
        reason text not null check (char_length(reason) between 20 and 2000),
        status text not null default 'open' check (status in ('open','upheld','reversed')),
        decided_by uuid references users(id),
        decision text not null default '',
        created_at timestamptz not null default now(),
        decided_at timestamptz
      )`,
      `create unique index transfer_disputes_one_open on transfer_disputes(transfer_id) where status = 'open'`,
    ],
  },
  {
    id: 18,
    name: "clans_wars_ladders",
    statements: [
      // A clan: a community of players across games; a player belongs to one clan at a time.
      `create table clans (
        id uuid primary key default gen_random_uuid(),
        slug text not null unique,
        name text not null check (char_length(name) between 2 and 40),
        tag text not null check (tag ~ '^[A-Z0-9]{2,5}$'),
        description text not null default '' check (char_length(description) <= 500),
        status text not null default 'active' check (status in ('active','disbanded')),
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        disbanded_at timestamptz
      )`,
      `create unique index clans_tag_active on clans(tag) where status = 'active'`,
      `create unique index clans_name_active on clans(lower(name)) where status = 'active'`,
      `create table clan_members (
        clan_id uuid not null references clans(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        role text not null default 'member' check (role in ('owner','officer','member')),
        joined_at timestamptz not null default now(),
        primary key (clan_id, user_id)
      )`,
      `create unique index clan_members_one_clan on clan_members(user_id)`,
      `create unique index clan_members_one_owner on clan_members(clan_id) where role = 'owner'`,
      `create table clan_invites (
        id uuid primary key default gen_random_uuid(),
        clan_id uuid not null references clans(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        invited_by uuid not null references users(id),
        status text not null default 'pending' check (status in ('pending','accepted','declined','revoked')),
        created_at timestamptz not null default now(),
        responded_at timestamptz
      )`,
      `create unique index clan_invites_one_pending on clan_invites(clan_id, user_id) where status = 'pending'`,
      // A clan war: a series between two clans in one game, lineups of the same size, a scheduled start.
      `create table clan_wars (
        id uuid primary key default gen_random_uuid(),
        game text not null,
        challenger_id uuid not null references clans(id),
        opponent_id uuid not null references clans(id),
        side_size int not null check (side_size between 1 and 6),
        best_of int not null check (best_of in (1, 3, 5)),
        scheduled_at timestamptz not null,
        message text not null default '' check (char_length(message) <= 300),
        status text not null default 'proposed' check (status in ('proposed','accepted','reported','completed','disputed','declined','cancelled','expired','void')),
        proposed_by uuid not null references users(id),
        answer_by timestamptz not null,
        answered_by uuid references users(id),
        reported_by uuid references users(id),
        reported_clan uuid references clans(id),
        score_challenger int check (score_challenger between 0 and 3),
        score_opponent int check (score_opponent between 0 and 3),
        reported_at timestamptz,
        confirmed_by uuid references users(id),
        winner_id uuid references clans(id),
        completed_at timestamptz,
        season text check (season ~ '^[0-9]{4}-Q[1-4]$'),
        rated boolean not null default false,
        dispute_reason text not null default '',
        disputed_by uuid references users(id),
        decided_by uuid references users(id),
        decision text not null default '',
        closed_by uuid references users(id),
        created_at timestamptz not null default now(),
        check (challenger_id <> opponent_id)
      )`,
      `create unique index clan_wars_one_open on clan_wars(least(challenger_id, opponent_id), greatest(challenger_id, opponent_id), game)
        where status in ('proposed','accepted','reported','disputed')`,
      `create index clan_wars_challenger on clan_wars(challenger_id, scheduled_at desc)`,
      `create index clan_wars_opponent on clan_wars(opponent_id, scheduled_at desc)`,
      `create index clan_wars_open on clan_wars(status) where status in ('proposed','accepted','reported','disputed')`,
      `create table clan_war_lineups (
        war_id uuid not null references clan_wars(id) on delete cascade,
        clan_id uuid not null references clans(id),
        user_id uuid not null references users(id),
        primary key (war_id, user_id)
      )`,
      // Seasonal ladder of clans by game (MV-LADDER-1): a season is a calendar quarter in UTC.
      `create table clan_ladder (
        season text not null check (season ~ '^[0-9]{4}-Q[1-4]$'),
        game text not null,
        clan_id uuid not null references clans(id) on delete cascade,
        rating int not null default 1000,
        wars int not null default 0,
        wins int not null default 0,
        losses int not null default 0,
        peak int not null default 1000,
        updated_at timestamptz not null default now(),
        primary key (season, game, clan_id)
      )`,
      `create index clan_ladder_board on clan_ladder(season, game, rating desc)`,
      `create table clan_ladder_events (
        war_id uuid not null references clan_wars(id) on delete cascade,
        clan_id uuid not null references clans(id) on delete cascade,
        season text not null,
        game text not null,
        result text not null check (result in ('win','loss')),
        before int not null,
        after int not null,
        delta int not null,
        created_at timestamptz not null default now(),
        primary key (war_id, clan_id)
      )`,
    ],
  },
  {
    id: 19,
    name: "partner_api_webhooks",
    statements: [
      // Partner API keys of an organising space: only a SHA-256 of the key is kept; the key is shown once.
      `create table api_keys (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references organizations(id) on delete cascade,
        name text not null check (char_length(name) between 2 and 60),
        prefix text not null,
        key_hash text not null unique,
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        last_used_at timestamptz,
        revoked_at timestamptz,
        revoked_by uuid references users(id)
      )`,
      `create index api_keys_org on api_keys(org_id, created_at desc)`,
      // Requests per key and minute (rate limit); old windows are removed by maintenance.
      `create table api_key_usage (
        key_id uuid not null references api_keys(id) on delete cascade,
        window_start timestamptz not null,
        count int not null default 0,
        primary key (key_id, window_start)
      )`,
      // Webhook endpoints: HTTPS URL, subscribed events, a signing secret sealed at rest.
      `create table webhook_endpoints (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references organizations(id) on delete cascade,
        url text not null check (char_length(url) <= 500),
        events text[] not null,
        secret text not null,
        scheme text not null check (scheme in ('aes-256-gcm','plain')),
        active boolean not null default true,
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        secret_rotated_at timestamptz
      )`,
      `create index webhook_endpoints_org on webhook_endpoints(org_id) where active`,
      // Outbox of deliveries: one per endpoint and event; retried with backoff, then failed.
      `create table webhook_deliveries (
        id uuid primary key default gen_random_uuid(),
        endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
        event_id text not null,
        event_type text not null,
        payload jsonb not null,
        status text not null default 'pending' check (status in ('pending','delivered','failed')),
        attempts int not null default 0,
        next_attempt_at timestamptz not null default now(),
        last_status int,
        last_error text not null default '',
        created_at timestamptz not null default now(),
        delivered_at timestamptz,
        unique (endpoint_id, event_id)
      )`,
      `create index webhook_deliveries_due on webhook_deliveries(next_attempt_at) where status = 'pending'`,
      `create index webhook_deliveries_endpoint on webhook_deliveries(endpoint_id, created_at desc)`,
      // Events are read from the hash-chained audit log after this point: what a transaction did is logged in
      // that same transaction, so every committed change becomes an event exactly once.
      `create table webhook_cursor (
        id int primary key check (id = 1),
        last_audit_id bigint not null
      )`,
      `insert into webhook_cursor (id, last_audit_id) select 1, coalesce(max(id), 0) from audit_log`,
    ],
  },
  {
    id: 20,
    name: "venues_passes",
    statements: [
      // Physical venues of an organising space. Only a confirmed venue is public; a change of its name or address
      // sends it back for confirmation.
      `create table venues (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references organizations(id) on delete cascade,
        slug text not null unique,
        name text not null check (char_length(name) between 2 and 80),
        kind text not null check (kind in ('club','arena','games_house','clubhouse','other')),
        address text not null check (char_length(address) between 5 and 200),
        city text not null check (char_length(city) between 2 and 80),
        country_code text check (country_code ~ '^[A-Z]{2}$'),
        description text not null default '' check (char_length(description) <= 1000),
        website text not null default '' check (char_length(website) <= 300),
        status text not null default 'draft' check (status in ('draft','submitted','confirmed','rejected','suspended')),
        review_note text not null default '',
        reviewed_by uuid references users(id),
        reviewed_at timestamptz,
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index venues_public on venues(city, name) where status = 'confirmed'`,
      `create index venues_org on venues(org_id)`,
      `alter table tournaments add column venue_id uuid references venues(id)`,
      // QR passes: the token is never stored in the clear for lookup (SHA-256), and it is sealed for showing the QR again.
      `create table venue_passes (
        id uuid primary key default gen_random_uuid(),
        venue_id uuid not null references venues(id) on delete cascade,
        user_id uuid not null references users(id),
        tournament_id uuid references tournaments(id) on delete cascade,
        kind text not null check (kind in ('event','guest')),
        valid_from timestamptz not null,
        valid_until timestamptz not null,
        token_hash text not null unique,
        token_sealed text not null,
        scheme text not null check (scheme in ('aes-256-gcm','plain')),
        status text not null default 'active' check (status in ('active','used','revoked')),
        used_at timestamptz,
        used_by uuid references users(id),
        revoked_at timestamptz,
        revoked_by uuid references users(id),
        note text not null default '' check (char_length(note) <= 200),
        issued_by uuid references users(id),
        created_at timestamptz not null default now(),
        check (valid_until > valid_from),
        check ((kind = 'event') = (tournament_id is not null))
      )`,
      `create unique index venue_passes_event on venue_passes(tournament_id, user_id) where tournament_id is not null`,
      `create index venue_passes_user on venue_passes(user_id, valid_until desc)`,
      `create index venue_passes_venue on venue_passes(venue_id, created_at desc)`,
      // Every scan, admitted or refused, for the venue's log.
      `create table venue_checkins (
        id bigserial primary key,
        venue_id uuid not null references venues(id) on delete cascade,
        pass_id uuid references venue_passes(id) on delete set null,
        staff_id uuid not null references users(id),
        result text not null check (result in ('admitted','used','expired','not_yet','revoked','withdrawn','wrong_venue')),
        at timestamptz not null default now()
      )`,
      `create index venue_checkins_venue on venue_checkins(venue_id, at desc)`,
    ],
  },
  {
    id: 21,
    name: "staff_roles_messages_flags",
    statements: [
      // Platform staff roles by duty (MV-STAFF-1). The older narrower check is replaced by definition.
      `do $$ declare r record; begin
         for r in select conname from pg_constraint
                   where conrelid = 'user_roles'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%role%' loop
           execute format('alter table user_roles drop constraint %I', r.conname);
         end loop;
       end $$`,
      `alter table user_roles add constraint user_roles_role_check
         check (role in ('admin','support','moderation','referee','finance','compliance','analytics','marketing','infrastructure'))`,
      // Feature switches and maintenance: a missing row means the default (features on, maintenance off).
      `create table feature_flags (
        key text primary key check (key ~ '^[a-z_]{3,40}$'),
        enabled boolean not null,
        note text not null default '' check (char_length(note) <= 300),
        updated_by uuid references users(id),
        updated_at timestamptz not null default now()
      )`,
      // The last run of each scheduled job, for the status panel.
      `create table system_runs (
        name text primary key,
        last_at timestamptz not null,
        result jsonb not null default '{}'
      )`,
      // Staff messages: operational or marketing, to a segment, delivered in the portal. A template is a
      // reusable text that is never sent itself; a draft is copied from it.
      `create table staff_messages (
        id uuid primary key default gen_random_uuid(),
        kind text not null check (kind in ('operational','marketing')),
        title text not null check (char_length(title) between 3 and 120),
        body text not null check (char_length(body) between 1 and 2000),
        segment jsonb not null default '{}',
        status text not null default 'draft' check (status in ('draft','template','sent')),
        stats jsonb not null default '{}',
        created_by uuid not null references users(id),
        created_at timestamptz not null default now(),
        sent_by uuid references users(id),
        sent_at timestamptz
      )`,
      `create table message_recipients (
        message_id uuid not null references staff_messages(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        status text not null check (status in ('sent','skipped_consent','skipped_cap')),
        created_at timestamptz not null default now(),
        opened_at timestamptz,
        primary key (message_id, user_id)
      )`,
      `create index message_recipients_user on message_recipients(user_id, created_at desc) where status = 'sent'`,
    ],
  },
  {
    id: 22,
    name: "streams_recordings",
    statements: [
      // Broadcasts and recordings of an event or of one of its matches (MV-MEDIA-1). A regenerated bracket
      // removes its matches: their streams then belong to the event as a whole.
      `create table streams (
        id uuid primary key default gen_random_uuid(),
        tournament_id uuid not null references tournaments(id) on delete cascade,
        match_id uuid references matches(id) on delete set null,
        kind text not null check (kind in ('live','vod')),
        platform text not null check (platform in ('twitch','youtube','kick','vk','other')),
        url text not null check (url ~ '^https://' and char_length(url) <= 500),
        title text not null default '' check (char_length(title) <= 80),
        language text not null default '' check (language in ('','ru','en','other')),
        starts_at timestamptz,
        rights_confirmed_by uuid not null references users(id),
        rights_confirmed_at timestamptz not null default now(),
        created_at timestamptz not null default now()
      )`,
      `create unique index streams_unique on streams(tournament_id, coalesce(match_id::text, ''), kind, url)`,
      `create index streams_tournament on streams(tournament_id, created_at)`,
      `create index streams_match on streams(match_id) where match_id is not null`,
    ],
  },
  {
    id: 23,
    name: "academy_coaching",
    statements: [
      // Coaches are public only once portal staff verify the stated experience (MV-ACADEMY-1).
      `create table coaches (
        user_id uuid primary key references users(id) on delete cascade,
        headline text not null check (char_length(headline) between 3 and 80),
        bio text not null default '' check (char_length(bio) <= 1500),
        experience text not null check (char_length(experience) between 20 and 1000),
        games text[] not null check (cardinality(games) between 1 and 5),
        languages text[] not null check (cardinality(languages) between 1 and 3),
        formats text[] not null check (cardinality(formats) between 1 and 2),
        city text not null default '' check (char_length(city) <= 80),
        accepting boolean not null default true,
        status text not null default 'draft' check (status in ('draft','submitted','verified','rejected','suspended')),
        review_note text not null default '' check (char_length(review_note) <= 500),
        reviewed_by uuid references users(id),
        reviewed_at timestamptz,
        verified_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index coaches_status on coaches(status)`,
      `create table academy_programmes (
        id uuid primary key default gen_random_uuid(),
        coach_id uuid not null references coaches(user_id) on delete cascade,
        title text not null check (char_length(title) between 3 and 80),
        game text not null,
        level text not null check (level in ('beginner','intermediate','advanced')),
        format text not null check (format in ('online','offline')),
        description text not null default '' check (char_length(description) <= 2000),
        sessions int not null check (sessions between 1 and 50),
        session_minutes int not null check (session_minutes between 30 and 240),
        status text not null default 'draft' check (status in ('draft','published','archived')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index academy_programmes_coach on academy_programmes(coach_id)`,
      // A training request is the engagement between a student and a coach: sessions and progress hang on it.
      `create table coaching_requests (
        id uuid primary key default gen_random_uuid(),
        coach_id uuid not null references users(id) on delete cascade,
        student_id uuid not null references users(id) on delete cascade,
        programme_id uuid references academy_programmes(id) on delete set null,
        game text not null,
        goal text not null check (char_length(goal) between 10 and 1000),
        availability text not null default '' check (char_length(availability) <= 300),
        status text not null default 'pending' check (status in ('pending','accepted','declined','cancelled','completed')),
        coach_note text not null default '' check (char_length(coach_note) <= 500),
        created_at timestamptz not null default now(),
        decided_at timestamptz,
        closed_at timestamptz,
        check (coach_id <> student_id)
      )`,
      `create unique index coaching_requests_open on coaching_requests(coach_id, student_id) where status in ('pending','accepted')`,
      `create index coaching_requests_coach on coaching_requests(coach_id, status, created_at)`,
      `create index coaching_requests_student on coaching_requests(student_id, created_at desc)`,
      `create table coaching_sessions (
        id uuid primary key default gen_random_uuid(),
        request_id uuid not null references coaching_requests(id) on delete cascade,
        starts_at timestamptz not null,
        minutes int not null check (minutes between 30 and 240),
        place text not null default '' check (char_length(place) <= 300),
        status text not null default 'scheduled' check (status in ('scheduled','done','cancelled','no_show')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`,
      `create index coaching_sessions_request on coaching_sessions(request_id, starts_at)`,
      // Progress keeps the coach's observation (a fact, with a time mark in a replay or video), the coach's
      // recommendation (an exercise) and measurements apart.
      `create table progress_records (
        id uuid primary key default gen_random_uuid(),
        request_id uuid not null references coaching_requests(id) on delete cascade,
        session_id uuid references coaching_sessions(id) on delete set null,
        author_id uuid not null references users(id),
        kind text not null check (kind in ('observation','exercise','measure')),
        body text not null check (char_length(body) between 3 and 1000),
        evidence_url text not null default '' check (evidence_url = '' or evidence_url ~ '^https://'),
        time_mark text not null default '' check (time_mark ~ '^([0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}$' or time_mark = ''),
        metric text not null default '' check (char_length(metric) <= 60),
        value numeric,
        created_at timestamptz not null default now(),
        check ((kind = 'measure') = (value is not null and metric <> ''))
      )`,
      `create index progress_records_request on progress_records(request_id, created_at)`,
    ],
  },
  {
    id: 24,
    name: "stage_chains",
    statements: [
      // Chains of stages (MV-STAGES-2): the main stage (1), further round stages (2…), the playoff last.
      // The narrower stage checks are replaced by definition. The slot key (tournament, bracket, round, position)
      // stays as it is, so earlier code keeps working: a chained stage numbers its matches after those of the
      // earlier stages in the same round.
      `do $$ declare r record; begin
         for r in select conrelid::regclass::text as tbl, conname from pg_constraint
                   where conrelid in ('tournaments'::regclass, 'matches'::regclass, 'stage_entries'::regclass)
                     and contype = 'c' and pg_get_constraintdef(oid) ~ '\\mstage\\M' loop
           execute format('alter table %s drop constraint %I', r.tbl, r.conname);
         end loop;
       end $$`,
      `alter table tournaments add constraint tournaments_stage_check check (stage between 1 and 8)`,
      `alter table matches add constraint matches_stage_check check (stage between 1 and 8)`,
      `alter table stage_entries add constraint stage_entries_stage_check check (stage between 2 and 8)`,
    ],
  },
];
