import type { Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";

/** All invitation tokens stay within the current team's leadership view. */
export async function myTeamDesk(q: Queryable, user: SessionUser, search = "") {
  const query = search.trim().replace(/^@/, "").slice(0, 40).toLowerCase();
  const [teams, incoming, outgoing, reservations] = await Promise.all([
    q.query<{ id: string; slug: string; name: string; game: string; leader: boolean; members: number }>(`select t.id,t.slug,t.name,t.game,
      (t.owner_id=$1 or t.captain_id=$1) as leader,
      (select count(*)::int from team_members tm join users u on u.id=tm.user_id where tm.team_id=t.id and u.status='active') as members
      from teams t where t.owner_id=$1 or t.captain_id=$1 or exists(select 1 from team_members m where m.team_id=t.id and m.user_id=$1)
      order by lower(t.name),t.id`, [user.id]),
    q.query<{ id: string; team_name: string; team_slug: string; game: string; invited_by: string }>(`select i.id,t.name as team_name,t.slug as team_slug,t.game,u.username as invited_by
      from team_invites i join teams t on t.id=i.team_id join users u on u.id=i.invited_by
      left join team_invitation_deliveries d on d.team_invite_id=i.id
      where i.user_id=$1 and i.status='pending' and (d.id is null or (d.status='pending' and d.expires_at>now()))
      order by i.created_at desc limit 100`, [user.id]),
    q.query<{ id: string; team_name: string; team_slug: string; username: string; status: string; created_at: Date }>(`select i.id,t.name as team_name,t.slug as team_slug,u.username,
      case when d.status='pending' and d.expires_at<=now() then 'expired' else coalesce(d.status,i.status) end as status,i.created_at
      from team_invites i join teams t on t.id=i.team_id join users u on u.id=i.user_id
      left join team_invitation_deliveries d on d.team_invite_id=i.id
      where (t.owner_id=$1 or t.captain_id=$1) and u.status<>'deleted' and strpos(u.username,$2)>0
      order by (i.status='pending' and (d.id is null or (d.status='pending' and d.expires_at>now()))) desc,i.created_at desc limit 100`, [user.id, query]),
    q.query<{ id: string; team_id: string; team_name: string; team_slug: string; username: string; status: string; expires_at: Date; delivery_id: string | null }>(`select r.id,r.team_id,t.name as team_name,t.slug as team_slug,r.username,
      case when r.status='pending' and r.expires_at<=now() then 'expired' else r.status end as status,r.expires_at,(select d.id from team_invitation_deliveries d where d.reservation_id=r.id) as delivery_id
      from username_reservations r join teams t on t.id=r.team_id where (t.owner_id=$1 or t.captain_id=$1) and strpos(r.username,$2)>0
      order by (r.status='pending' and r.expires_at>now()) desc,r.created_at desc limit 100`, [user.id, query]),
  ]);
  return { teams, incoming, outgoing, reservations };
}
