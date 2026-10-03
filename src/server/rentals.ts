import { createHash, randomBytes } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount } from "./product-access.ts";
import { requireSection } from "./access.ts";
import { audit } from "./audit.ts";
import { fail } from "./errors.ts";
import { isGame } from "../lib/games.ts";
import * as v from "./validate.ts";

export type RentalPort = { name: string; container: number; protocol: "tcp" | "udp"; host?: number };
export type RentalNode = {
  id: string; owner_id: string; name: string; region: string; address: string; cpu_millis: number; memory_mb: number;
  storage_mb: number; port_start: number; port_end: number; status: string; enabled: boolean; ready: boolean;
  ready_templates: string[]; heartbeat_at: Date | null; key_epoch: number; review_note: string;
};
export type RentalTemplate = {
  id: string; node_id: string; name: string; game: string; local_key: string; fingerprint: string; cpu_millis: number;
  memory_mb: number; disk_mb: number; ports: RentalPort[]; evidence_url: string; status: string; review_note: string;
};
export type RentalLease = {
  id: string; node_id: string; template_id: string; user_id: string; revision: number; desired: "running" | "stopped" | "released";
  observed: string; cpu_millis: number; memory_mb: number; disk_mb: number; ports: RentalPort[];
  created_at: Date; starts_at: Date; expires_at: Date; last_command_at: Date | null; released_at: Date | null; observed_at: Date | null; note: string; logs: string;
};
export type RentalJob = { id: string; lease_id: string; revision: number; kind: string; status: string; backup_id: string | null; note: string; created_at: Date };
export type RentalBackup = { id: string; lease_id: string; digest: string; bytes: string; created_at: Date; deleted_at: Date | null };
const uuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const digest = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const scopedKey = (s: unknown) => typeof s === "string" && /^[a-z0-9][a-z0-9_-]{1,39}$/.test(s);
const activeUserSql = (alias: string) => `${alias}.status='active' and not exists(select 1 from sanctions x where x.user_id=${alias}.id and x.kind='suspension' and x.revoked_at is null and x.starts_at<=now() and (x.ends_at is null or x.ends_at>now()))`;

export function rentalPorts(value: unknown): RentalPort[] {
  let rows: unknown = value;
  if (typeof rows === "string") { try { rows = JSON.parse(rows); } catch { fail("invalid_input"); } }
  if (!Array.isArray(rows) || !rows.length || rows.length > 8) return fail("invalid_input");
  const names = new Set<string>(), sockets = new Set<string>();
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return fail("invalid_input");
    const d = row as Record<string, unknown>;
    if (!scopedKey(d.name) || !["tcp", "udp"].includes(String(d.protocol))) return fail("invalid_input");
    const port = v.intIn(d.container, 1024, 65535), socket = `${port}/${d.protocol}`;
    if (names.has(String(d.name)) || sockets.has(socket)) return fail("invalid_input");
    names.add(String(d.name)); sockets.add(socket);
    return { name: String(d.name), container: port, protocol: d.protocol as "tcp" | "udp" };
  });
}

async function nodeForOwner(q: Queryable, user: SessionUser, id: string) {
  const [node] = await q.query<RentalNode>("select * from rental_nodes where id=$1 and owner_id=$2 for update", [id, user.id]);
  if (!node) return fail("not_found"); return node;
}
async function stopNodeLeases(q: Queryable, id: string) {
  await q.query("update rental_leases set desired='released',revision=revision+1 where node_id=$1 and released_at is null and desired<>'released'", [id]);
  await q.query("update rental_jobs set status='cancelled',finished_at=now() where lease_id in(select id from rental_leases where node_id=$1) and status in('pending','running')", [id]);
}
async function reconcileNode(q: Queryable, id: string) {
  // All lifecycle writers lock the node before leases. Expired resources stay reserved until an agent confirms cleanup.
  await q.query(`update rental_leases l set desired='released',revision=revision+1 where node_id=$1 and released_at is null and desired<>'released' and
    (expires_at<=now() or not exists(select 1 from users u where u.id=l.user_id and ${activeUserSql("u")})
    or not exists(select 1 from rental_templates t where t.id=l.template_id and t.status='approved'))`, [id]);
  await q.query("update rental_jobs set status='cancelled',finished_at=now() where lease_id in(select id from rental_leases where node_id=$1 and desired='released') and status in('pending','running')", [id]);
}

export async function registerRentalNode(db: Database, user: SessionUser, input: Record<string, unknown>) {
  if (!v.bool(input.consent)) fail("consent_required");
  const address = v.oneLine(input.address, 253).toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(address) || address.includes("..")) fail("invalid_input");
  const ports = [v.intIn(input.portStart, 1024, 65000), v.intIn(input.portEnd, 1024, 65535)];
  if (ports[1] < ports[0] || ports[1] - ports[0] > 511) fail("invalid_input");
  return db.tx(async q => {
    await activeAccount(q, user); await q.query("select id from users where id=$1 for update", [user.id]);
    const [count] = await q.query<{ n: number }>("select count(*)::int n from rental_nodes where owner_id=$1", [user.id]);
    if (count.n >= 10) fail("request_limit");
    const [node] = await q.query<{ id: string }>(`insert into rental_nodes(owner_id,name,region,address,cpu_millis,memory_mb,storage_mb,port_start,port_end)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [user.id, v.displayName(input.name, 80), v.displayName(input.region, 60), address,
      v.intIn(input.cpuMillis, 1000, 256000), v.intIn(input.memoryMb, 512, 1048576), v.intIn(input.storageMb, 1024, 16777216), ...ports]);
    await audit(q, { actorId: user.id, action: "rental.node_registered", entity: "rental_node", entityId: node.id }); return node.id;
  });
}
export async function reviewRentalNode(db: Database, staff: SessionUser, id: string, decision: string, note: string) {
  requireSection(staff, "system"); if (!["approved", "suspended"].includes(decision) || note.trim().length < 10) fail("invalid_input");
  await db.tx(async q => {
    const [node] = await q.query<RentalNode>("select * from rental_nodes where id=$1 for update", [id]);
    if (!node) fail("not_found"); if (node.owner_id === staff.id) fail("cannot_modify_self");
    await q.query("update rental_nodes set status=$2,enabled=false,ready=false,review_note=$3,reviewed_by=$4,reviewed_at=now() where id=$1", [id, decision, v.clean(note, 1000), staff.id]);
    await stopNodeLeases(q, id);
    await audit(q, { actorId: staff.id, action: "rental.node_reviewed", entity: "rental_node", entityId: id, data: { decision } });
  });
}
export async function setRentalNodeEnabled(db: Database, user: SessionUser, id: string, enabled: boolean) {
  await db.tx(async q => {
    await activeAccount(q, user); const node = await nodeForOwner(q, user, id);
    if (enabled && node.status !== "approved") fail("feature_disabled");
    await q.query("update rental_nodes set enabled=$2 where id=$1", [id, enabled]);
    await audit(q, { actorId: user.id, action: "rental.node_availability", entity: "rental_node", entityId: id, data: { enabled } });
  });
}
export async function rotateRentalKey(db: Database, user: SessionUser, id: string, revoke = false) {
  const token = `mvr_${randomBytes(32).toString("base64url")}`;
  await db.tx(async q => {
    await activeAccount(q, user); await nodeForOwner(q, user, id);
    await q.query("update rental_nodes set key_hash=$2,key_epoch=key_epoch+1,ready=false,enabled=false where id=$1", [id, revoke ? null : hash(token)]);
    await stopNodeLeases(q, id);
    await audit(q, { actorId: user.id, action: "rental.node_key_rotated", entity: "rental_node", entityId: id });
  }); return revoke ? null : token;
}
export async function createRentalTemplate(db: Database, user: SessionUser, nodeId: string, input: Record<string, unknown>) {
  if (!isGame(input.game) || !scopedKey(input.localKey) || !digest(input.fingerprint)) fail("invalid_input");
  let evidence: URL; try { evidence = new URL(String(input.evidence)); } catch { return fail("invalid_input"); }
  if (evidence.protocol !== "https:" || evidence.username || evidence.password || evidence.href.length > 1000) fail("invalid_input");
  const ports = rentalPorts(input.ports), cpu = v.intIn(input.cpuMillis, 250, 128000), memory = v.intIn(input.memoryMb, 256, 524288), disk = v.intIn(input.diskMb, 256, 4194304);
  return db.tx(async q => {
    await activeAccount(q, user); const node = await nodeForOwner(q, user, nodeId);
    if (cpu > node.cpu_millis || memory > node.memory_mb || disk * 5 > node.storage_mb || ports.length > node.port_end - node.port_start + 1) fail("invalid_input");
    const [n] = await q.query<{ n: number }>("select count(*)::int n from rental_templates where node_id=$1", [nodeId]); if (n.n >= 30) fail("request_limit");
    const [template] = await q.query<{ id: string }>(`insert into rental_templates(node_id,name,game,local_key,fingerprint,cpu_millis,memory_mb,disk_mb,ports,evidence_url)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [nodeId, v.displayName(input.name, 100), input.game, input.localKey, input.fingerprint, cpu, memory, disk, JSON.stringify(ports), evidence.href]);
    await audit(q, { actorId: user.id, action: "rental.template_registered", entity: "rental_template", entityId: template.id }); return template.id;
  });
}
export async function reviewRentalTemplate(db: Database, staff: SessionUser, id: string, decision: string, note: string) {
  requireSection(staff, "system"); if (!["approved", "suspended"].includes(decision) || note.trim().length < 10) fail("invalid_input");
  await db.tx(async q => {
    const [template] = await q.query<RentalTemplate>("select * from rental_templates where id=$1", [id]); if (!template) fail("not_found");
    const [node] = await q.query<RentalNode>("select * from rental_nodes where id=$1 for update", [template.node_id]);
    if (node.owner_id === staff.id) fail("cannot_modify_self"); if (decision === "approved" && node.status !== "approved") fail("feature_disabled");
    await q.query("update rental_templates set status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now() where id=$1", [id, decision, v.clean(note, 1000), staff.id]);
    await reconcileNode(q, node.id);
    await audit(q, { actorId: staff.id, action: "rental.template_reviewed", entity: "rental_template", entityId: id, data: { decision } });
  });
}

export async function allocateRental(db: Database, user: SessionUser, templateId: string, minutes: unknown, consent: boolean, delayMinutes: unknown = 0) {
  if (!consent) fail("consent_required"); const duration = v.intIn(minutes, 30, 240), delay = v.intIn(delayMinutes, 0, 1440);
  return db.tx(async q => {
    await activeAccount(q, user); await q.query("select id from users where id=$1 for update", [user.id]);
    if ((await q.query("select 1 from rental_leases where user_id=$1 and released_at is null", [user.id]))[0]) fail("request_exists");
    const [daily] = await q.query<{n:number}>("select count(*)::int n from rental_leases where user_id=$1 and created_at>now()-interval '1 day'",[user.id]);
    if(daily.n>=12)fail("request_limit");
    const [template] = await q.query<RentalTemplate>("select * from rental_templates where id=$1", [templateId]); if (!template) fail("not_found");
    const [node] = await q.query<RentalNode>(`select n.* from rental_nodes n join users u on u.id=n.owner_id where n.id=$1 and n.status='approved' and n.enabled and n.ready
      and n.heartbeat_at>now()-interval '45 seconds' and ${activeUserSql("u")} for update of n`, [template.node_id]);
    if (!node || node.owner_id === user.id || template.status !== "approved" || !node.ready_templates.includes(template.fingerprint)) fail("offer_unavailable");
    // Re-read after the node lock: a reviewer may have suspended the template while this request waited.
    const [approved] = await q.query("select 1 from rental_templates where id=$1 and status='approved'", [templateId]); if (!approved) fail("offer_unavailable");
    const held = await q.query<RentalLease>("select * from rental_leases where node_id=$1 and released_at is null", [node.id]);
    if (held.length >= 16 || held.reduce((s,l)=>s+l.cpu_millis,template.cpu_millis)>node.cpu_millis || held.reduce((s,l)=>s+l.memory_mb,template.memory_mb)>node.memory_mb || held.reduce((s,l)=>s+l.disk_mb*5,template.disk_mb*5)>node.storage_mb) fail("offer_unavailable");
    const used = new Set(held.flatMap(l=>l.ports.map(p=>p.host))), available: number[] = [];
    for (let port=node.port_start;port<=node.port_end && available.length<template.ports.length;port++) if (!used.has(port)) available.push(port);
    if (available.length !== template.ports.length) fail("offer_unavailable");
    const [lease] = await q.query<{ id: string }>(`insert into rental_leases(node_id,template_id,user_id,cpu_millis,memory_mb,disk_mb,ports,starts_at,expires_at)
      values($1,$2,$3,$4,$5,$6,$7,now()+$9*interval '1 minute',now()+($8+$9)*interval '1 minute') returning id`, [node.id, templateId, user.id, template.cpu_millis, template.memory_mb, template.disk_mb, JSON.stringify(template.ports.map((p,i)=>({...p,host:available[i]}))), duration, delay]);
    await audit(q, { actorId: user.id, action: "rental.allocated", entity: "rental_lease", entityId: lease.id, data: { duration, delay, templateId } }); return lease.id;
  });
}

async function leaseForActor(q: Queryable, user: SessionUser, id: string) {
  const [lease] = await q.query<RentalLease>("select * from rental_leases where id=$1", [id]); if (!lease) return fail("not_found");
  const [node] = await q.query<RentalNode>("select * from rental_nodes where id=$1 for update", [lease.node_id]);
  const role=lease.user_id===user.id?"owner":node.owner_id===user.id?"node":(await q.query<{role:string}>("select role from rental_access where lease_id=$1 and user_id=$2",[id,user.id]))[0]?.role;
  if(!role)fail("not_found");
  if(role==="viewer"||role==="operator")await activeAccount(q,user);
  await reconcileNode(q,node.id);
  const [current] = await q.query<RentalLease>("select * from rental_leases where id=$1 for update", [id]); return { lease: current, node, role };
}
export async function rentalCommand(db: Database, user: SessionUser, id: string, command: string) {
  if (!["start", "stop", "restart", "release"].includes(command)) fail("invalid_input");
  await db.tx(async q => {
    if (["start","restart"].includes(command)) await activeAccount(q,user);
    const {lease,node,role}=await leaseForActor(q,user,id); if(role==="viewer" || (command==="release" && role==="operator"))fail("forbidden"); if (lease.released_at || lease.desired === "released") { if (command==="release") return; fail("request_state"); }
    if (["start","restart"].includes(command) && (node.status!=="approved" || new Date(lease.expires_at).getTime()<=Date.now())) fail("request_state");
    if (command!=="release" && (await q.query("select 1 from rental_jobs where lease_id=$1 and status in('pending','running')",[id]))[0]) fail("request_state");
    if (command==="restart" && (await q.query("select 1 from rental_leases where id=$1 and last_command_at>now()-interval '30 seconds'",[id]))[0]) fail("request_limit");
    const desired=command==="release"?"released":command==="stop"?"stopped":"running";
    if (lease.desired===desired && command!=="restart") return;
    await q.query("update rental_leases set desired=$2,revision=revision+1,last_command_at=now() where id=$1",[id,desired]);
    if(command==="release") await q.query("update rental_jobs set status='cancelled',finished_at=now() where lease_id=$1 and status in('pending','running')",[id]);
    await audit(q,{actorId:user.id,action:`rental.${command}`,entity:"rental_lease",entityId:id});
  });
}
export async function rentalBackupJob(db: Database, user: SessionUser, id: string, kind: string, backupId?: string) {
  if (!["backup","restore"].includes(kind)) fail("invalid_input");
  return db.tx(async q=>{
    await activeAccount(q,user); const {lease,node,role}=await leaseForActor(q,user,id);
    if (!["owner","operator"].includes(role!) || lease.released_at || lease.desired!=="stopped" || lease.observed!=="stopped" || node.status!=="approved") fail("request_state");
    if((await q.query("select 1 from rental_jobs where lease_id=$1 and status in('pending','running')",[id]))[0]) fail("request_exists");
    const [count]=await q.query<{n:number}>("select count(*)::int n from rental_jobs where lease_id=$1",[id]);if(count.n>=20)fail("request_limit");
    if(kind==="backup") { const [n]=await q.query<{n:number}>("select count(*)::int n from rental_backups where lease_id=$1 and deleted_at is null",[id]);if(n.n>=3)fail("request_limit"); }
    else if(!uuid(backupId) || !(await q.query("select 1 from rental_backups where id=$1 and lease_id=$2 and deleted_at is null",[backupId,id]))[0])fail("not_found");
    const [job]=await q.query<{id:string}>("insert into rental_jobs(lease_id,revision,kind,backup_id) values($1,$2,$3,$4) returning id",[id,lease.revision,kind,kind==="restore"?backupId:null]);
    await audit(q,{actorId:user.id,action:`rental.${kind}_requested`,entity:"rental_job",entityId:job.id});return job.id;
  });
}

function safeLog(input: unknown, limit=8000) {
  return String(input??"").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,"")
    .replace(/\b(Bearer\s+|(?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,"$1[redacted]").slice(-limit);
}
export async function synchronizeRentalNode(db: Database, token: string, input: Record<string, unknown>) {
  if (!/^mvr_[a-z0-9_-]{43}$/i.test(token)) fail("unauthorized");
  if(!Array.isArray(input.reports)||input.reports.length>16 || !Array.isArray(input.templates)||input.templates.length>30||input.templates.some(s=>!digest(s)))fail("invalid_input");
  return db.tx(async q=>{
    const [node]=await q.query<RentalNode>("select * from rental_nodes where key_hash=$1 for update",[hash(token)]);if(!node)fail("unauthorized");
    const [owner]=await q.query(`select 1 from users u where u.id=$1 and ${activeUserSql("u")}`,[node.owner_id]);
    if(!owner||node.status!=="approved") await stopNodeLeases(q,node.id);
    await reconcileNode(q,node.id);
    await q.query("update rental_nodes set heartbeat_at=now(),ready=$2,ready_templates=$3 where id=$1",[node.id,Boolean(owner)&&node.status==="approved"&&input.ready===true,input.templates]);
    for(const raw of input.reports as unknown[]) {
      if(!raw||typeof raw!=="object"||Array.isArray(raw))fail("invalid_input");const report=raw as Record<string,unknown>;
      if(!uuid(report.id)||!Number.isSafeInteger(report.revision)||!["starting","running","stopped","error"].includes(String(report.status)))fail("invalid_input");
      const [lease]=await q.query<RentalLease>("select * from rental_leases where id=$1 and node_id=$2 for update",[report.id,node.id]);if(!lease)fail("forbidden");
      if(lease.released_at || lease.revision!==report.revision)continue;
      if(report.status==="running" && (lease.desired!=="running" || new Date(lease.starts_at).getTime()>Date.now()))continue;
      // A cleanup receipt is required before a release frees ports, memory and disk reservations.
      const released=lease.desired==="released"&&report.status==="stopped"&&report.cleaned===true;
      await q.query("update rental_leases set observed=$2,observed_at=now(),note=$3,logs=$4,released_at=case when $5 then now() else released_at end where id=$1",[lease.id,report.status,lease.desired==="released"?"":safeLog(report.note,500),lease.desired==="released"?"":safeLog(report.logs),released]);
      if(released) { await q.query("update rental_backups set deleted_at=now() where lease_id=$1",[lease.id]);await audit(q,{actorId:null,action:"rental.cleanup_confirmed",entity:"rental_lease",entityId:lease.id}); }
      const jobReport=report.job;
      if(jobReport&&typeof jobReport==="object"&&!Array.isArray(jobReport)&&lease.desired==="stopped"&&report.status==="stopped"){
        const j=jobReport as Record<string,unknown>;
        if(!uuid(j.id)||!["succeeded","failed"].includes(String(j.status)))fail("invalid_input");
        const [job]=await q.query<RentalJob>("select * from rental_jobs where id=$1 and lease_id=$2 and revision=$3 for update",[j.id,lease.id,lease.revision]);if(!job)fail("forbidden");
        if(["pending","running"].includes(job.status)){
          if(j.status==="succeeded"&&job.kind==="backup"){
            if(!digest(j.digest)||!Number.isSafeInteger(j.bytes)||Number(j.bytes)<0||Number(j.bytes)>lease.disk_mb*1048576)fail("invalid_input");
            await q.query("insert into rental_backups(id,lease_id,digest,bytes) values($1,$2,$3,$4) on conflict do nothing",[job.id,lease.id,j.digest,j.bytes]);
          }
          await q.query("update rental_jobs set status=$2,note=$3,finished_at=now() where id=$1",[job.id,j.status,safeLog(j.note,500)]);
          await audit(q,{actorId:null,action:`rental.${job.kind}_${j.status}`,entity:"rental_job",entityId:job.id});
        }
      }
    }
    const leases=await q.query<RentalLease & {local_key:string;fingerprint:string}>(`select l.*,t.local_key,t.fingerprint from rental_leases l join rental_templates t on t.id=l.template_id
      where l.node_id=$1 and l.released_at is null order by l.created_at`,[node.id]);
    const jobs=await q.query<RentalJob & {digest:string|null;bytes:string|null}>(`select j.*,b.digest,b.bytes from rental_jobs j join rental_leases l on l.id=j.lease_id left join rental_backups b on b.id=j.backup_id
      where l.node_id=$1 and l.released_at is null and l.desired='stopped' and l.observed='stopped' and j.revision=l.revision and j.status in('pending','running')`,[node.id]);
    for(const job of jobs)await q.query("update rental_jobs set status='running' where id=$1 and status='pending'",[job.id]);
    const [clock]=await q.query<{at:Date}>("select now() at");
    if(!owner&&!leases.length)await q.query("update rental_nodes set key_hash=null where id=$1",[node.id]);
    return {serverTime:clock.at,node:{id:node.id,keyEpoch:node.key_epoch,cpuMillis:node.cpu_millis,memoryMb:node.memory_mb,storageMb:node.storage_mb,portStart:node.port_start,portEnd:node.port_end},
      leases:leases.map(l=>({id:l.id,revision:l.revision,desired:l.desired,startsAt:l.starts_at,expiresAt:l.expires_at,localKey:l.local_key,fingerprint:l.fingerprint,cpuMillis:l.cpu_millis,memoryMb:l.memory_mb,diskMb:l.disk_mb,ports:l.ports})),
      jobs:jobs.map(j=>({id:j.id,leaseId:j.lease_id,revision:j.revision,kind:j.kind,backupId:j.backup_id,digest:j.digest,bytes:j.bytes}))};
  });
}

export async function rentalOverview(q: Queryable, userId?: string) {
  const offers=await q.query<RentalTemplate & {node_name:string;region:string}>(`select t.*,n.name node_name,n.region
    from rental_templates t join rental_nodes n on n.id=t.node_id join users u on u.id=n.owner_id
    cross join lateral(select coalesce(sum(l.cpu_millis),0) cpu,coalesce(sum(l.memory_mb),0) memory,coalesce(sum(l.disk_mb*5),0) disk,
      coalesce(sum(jsonb_array_length(l.ports)),0) ports,count(*) leases from rental_leases l where l.node_id=n.id and l.released_at is null) held
    where n.status='approved' and n.enabled and n.ready and n.heartbeat_at>now()-interval '45 seconds' and t.status='approved' and t.fingerprint=any(n.ready_templates)
    and held.leases<16 and held.cpu+t.cpu_millis<=n.cpu_millis and held.memory+t.memory_mb<=n.memory_mb and held.disk+t.disk_mb*5<=n.storage_mb
    and held.ports+jsonb_array_length(t.ports)<=n.port_end-n.port_start+1 and ${activeUserSql("u")} order by n.region,t.name limit 100`);
  const nodes=userId?await q.query<RentalNode>("select * from rental_nodes where owner_id=$1 order by created_at desc",[userId]):[];
  const leases=userId?await q.query<RentalLease & {name:string;address:string}>("select l.*,t.name,n.address from rental_leases l join rental_templates t on t.id=l.template_id join rental_nodes n on n.id=l.node_id where l.user_id=$1 or exists(select 1 from rental_access a where a.lease_id=l.id and a.user_id=$1) order by l.created_at desc limit 30",[userId]):[];
  return {offers,nodes,leases};
}
export async function rentalNodeDetail(q: Queryable, user: SessionUser, id: string) {
  const [node]=await q.query<RentalNode>("select * from rental_nodes where id=$1 and owner_id=$2",[id,user.id]);if(!node)fail("not_found");
  const templates=await q.query<RentalTemplate>("select * from rental_templates where node_id=$1 order by created_at",[id]);
  const leases=await q.query<RentalLease & {name:string}>("select l.*,t.name from rental_leases l join rental_templates t on t.id=l.template_id where l.node_id=$1 order by l.created_at desc limit 50",[id]);
  return {node,templates,leases};
}
export async function rentalLeaseDetail(q: Queryable, user: SessionUser, id: string) {
  const [lease]=await q.query<RentalLease & {name:string;address:string;owner_id:string;region:string}>(`select l.*,t.name,n.address,n.owner_id,n.region from rental_leases l join rental_templates t on t.id=l.template_id
    join rental_nodes n on n.id=l.node_id where l.id=$1 and ($2 in(l.user_id,n.owner_id) or exists(select 1 from rental_access a where a.lease_id=l.id and a.user_id=$2 and exists(select 1 from users u where u.id=$2 and ${activeUserSql("u")})))`,[id,user.id]);if(!lease)fail("not_found");
  const jobs=await q.query<RentalJob>("select * from rental_jobs where lease_id=$1 order by created_at desc",[id]);
  const backups=await q.query<RentalBackup>("select * from rental_backups where lease_id=$1 and deleted_at is null order by created_at desc",[id]);const access=await q.query<{user_id:string;username:string;role:string}>("select a.user_id,u.username,a.role from rental_access a join users u on u.id=a.user_id where a.lease_id=$1 order by u.username",[id]);
  const role=lease.user_id===user.id?"owner":lease.owner_id===user.id?"node":access.find(a=>a.user_id===user.id)?.role;
  return {lease,jobs,backups,access,role};
}
export async function eraseRentals(q: Queryable, userId: string) {
  const nodes=await q.query<{id:string}>("select n.id from rental_nodes n where n.owner_id=$1 or exists(select 1 from rental_leases l where l.node_id=n.id and l.user_id=$1 and l.released_at is null) order by n.id for update",[userId]);
  for(const node of nodes) {
    await q.query("update rental_leases set desired='released',revision=revision+1,note='',logs='' where node_id=$1 and released_at is null and (user_id=$2 or exists(select 1 from rental_nodes where id=$1 and owner_id=$2))",[node.id,userId]);
  }
  await q.query("delete from rental_access where user_id=$1 or lease_id in(select id from rental_leases where user_id=$1)",[userId]);
  await q.query("update rental_nodes set name='Deleted node',address='',region='',status='suspended',enabled=false,ready=false,review_note='' where owner_id=$1",[userId]);
  await q.query("update rental_leases set note='',logs='' where user_id=$1",[userId]);
  await q.query("update rental_jobs set note='',status=case when status in('pending','running') then 'cancelled' else status end where lease_id in(select l.id from rental_leases l join rental_nodes n on n.id=l.node_id where $1 in(l.user_id,n.owner_id))",[userId]);
  await q.query("update rental_backups set deleted_at=now() where lease_id in(select l.id from rental_leases l join rental_nodes n on n.id=l.node_id where $1 in(l.user_id,n.owner_id))",[userId]);
}

export async function setRentalAccess(db:Database,user:SessionUser,id:string,username:unknown,role:string){
  if(!["viewer","operator","remove"].includes(role))fail("invalid_input");const name=v.username(username);
  await db.tx(async q=>{
    await activeAccount(q,user);const {lease,node}=await leaseForActor(q,user,id);
    if(lease.user_id!==user.id)fail("forbidden");if(lease.released_at||lease.desired==="released")fail("request_state");
    const [target]=await q.query<{id:string}>("select id from users where username=$1 and status='active' and adult_confirmed_at is not null",[name]);
    if(!target)fail("not_found");if([user.id,node.owner_id].includes(target.id))fail("cannot_modify_self");
    if(role==="remove")await q.query("delete from rental_access where lease_id=$1 and user_id=$2",[id,target.id]);
    else{
      const [n]=await q.query<{n:number}>("select count(*)::int n from rental_access where lease_id=$1 and user_id<>$2",[id,target.id]);if(n.n>=16)fail("request_limit");
      await q.query("insert into rental_access(lease_id,user_id,role) values($1,$2,$3) on conflict(lease_id,user_id) do update set role=excluded.role",[id,target.id,role]);
    }
    await audit(q,{actorId:user.id,action:"rental.access_changed",entity:"rental_lease",entityId:id,data:{userId:target.id,role}});
  });
}
