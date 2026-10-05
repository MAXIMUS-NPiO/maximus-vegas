/** Additive invitation delivery migration. Recipient addresses are private operational data. */
export const teamInvitationStatements = [
  `create table team_invitation_deliveries (
    id uuid primary key default gen_random_uuid(),
    team_id uuid not null references teams(id) on delete cascade,
    invited_by uuid not null references users(id),
    recipient_user_id uuid references users(id) on delete set null,
    recipient_email text,
    requested_username text,
    recipient_key text not null,
    reservation_id uuid unique references username_reservations(id) on delete set null,
    team_invite_id uuid unique references team_invites(id) on delete set null,
    requires_email_verification boolean not null default false,
    lang text not null check (lang in ('ru','en')),
    status text not null default 'pending' check (status in ('pending','accepted','declined','revoked','expired')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '7 days',
    responded_at timestamptz,
    manual_retries int not null default 0 check (manual_retries between 0 and 3),
    last_retry_at timestamptz,
    check (recipient_email is not null or recipient_user_id is not null)
  )`,
  `create unique index team_invitation_active_recipient on team_invitation_deliveries(team_id,recipient_key) where status='pending'`,
  `create unique index team_invitation_active_user on team_invitation_deliveries(team_id,recipient_user_id) where status='pending' and recipient_user_id is not null`,
  `create unique index team_invitation_active_email on team_invitation_deliveries(team_id,recipient_email) where status='pending' and recipient_email is not null`,
  `create index team_invitation_actor_created on team_invitation_deliveries(invited_by,created_at)`,
  `create index team_invitation_recipient_created on team_invitation_deliveries(recipient_key,created_at)`,
  `create table team_invitation_requests (
    actor_id uuid not null references users(id) on delete cascade,
    request_id uuid not null,
    fingerprint text not null,
    delivery_id uuid not null references team_invitation_deliveries(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (actor_id,request_id)
  )`,
  `alter table email_outbox add column team_invitation_id uuid references team_invitation_deliveries(id) on delete cascade`,
  `create unique index email_outbox_team_invitation on email_outbox(team_invitation_id) where team_invitation_id is not null`,
  `create function validate_team_invitation_response() returns trigger language plpgsql as $$
    declare invitation team_invitation_deliveries%rowtype;
    begin
      if old.status='pending' and new.status in('accepted','declined') then
        select * into invitation from team_invitation_deliveries where team_invite_id=new.id;
        if found then
          if invitation.status<>'pending' or invitation.expires_at<=clock_timestamp() then
            raise exception using errcode='P0001',message='invite_not_found';
          end if;
          if invitation.requires_email_verification and not exists(
            select 1 from users where id=new.user_id and status='active' and email=invitation.recipient_email and email_verified_at is not null
          ) then
            raise exception using errcode='P0001',message='email_not_verified';
          end if;
        end if;
      end if;
      return new;
    end $$`,
  `create trigger team_invitation_response_guard before update of status on team_invites for each row execute function validate_team_invitation_response()`,
  `create function sync_team_invitation_response() returns trigger language plpgsql as $$
    begin
      if new.status<>old.status and new.status<>'pending' then
        update team_invitation_deliveries set status=new.status,responded_at=coalesce(new.responded_at,now())
        where team_invite_id=new.id and status='pending';
        update email_outbox set status='cancelled',locked_until=null,last_error=''
        where team_invitation_id in(select id from team_invitation_deliveries where team_invite_id=new.id)
          and status in('pending','failed','sending');
      end if;
      return new;
    end $$`,
  `create trigger team_invitation_response after update of status on team_invites for each row execute function sync_team_invitation_response()`,
  `create function sync_team_reservation_cancellation() returns trigger language plpgsql as $$
    begin
      if new.status<>old.status and new.status in('revoked','expired') then
        update team_invitation_deliveries set status=new.status,responded_at=now()
        where reservation_id=new.id and status='pending';
        update email_outbox set status='cancelled',locked_until=null,last_error=''
        where team_invitation_id in(select id from team_invitation_deliveries where reservation_id=new.id)
          and status in('pending','failed','sending');
      end if;
      return new;
    end $$`,
  `create trigger team_reservation_cancellation after update of status on username_reservations for each row execute function sync_team_reservation_cancellation()`,
];
