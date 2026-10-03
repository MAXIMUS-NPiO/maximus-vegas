/** Real browser media and local TURN. Synthetic devices replace human capture, not WebRTC. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import pg from "pg";
const BASE = process.env.BASE ?? "http://127.0.0.1:3100", url = process.env.PG_TEST_URL;
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE) || !url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname) || !new URL(url).pathname.startsWith("/c26_")) throw Error("Local C-26 fixtures only");
const events = [];
const fixture = JSON.parse(await readFile("artifacts/c26-fixture.json", "utf8")), errors = [], checks = [], pages = {};
const sql = new pg.Client({ connectionString: url }); await sql.connect();
let deniedBrowser;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const mark = s => { checks.push(s); console.log(`PASS ${s}`); };
async function eventually(fn, label, timeout = 25000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 250)); } throw Error(`Timed out: ${label}`); }
async function go(p, path) { const r = await p.goto(BASE + path); assert.ok(r.status() < 400); await p.waitForLoadState("load"); }
async function media(p) { return p.evaluate(async () => {
  const result = { captures: window.__captures, tracks: window.__streams.flatMap(s => s.getTracks()).map(t => ({ kind: t.kind, state: t.readyState, enabled: t.enabled })), connections: [] };
  for (const pc of window.__peers) { const stats = await pc.getStats(); const all = [...stats.values()], pairs = all.filter(s => s.type === "candidate-pair" && s.state === "succeeded" && s.nominated); result.connections.push({ state: pc.connectionState, signalling: pc.signalingState, local: pc.localDescription?.type, remote: pc.remoteDescription?.type, audio: all.filter(s => s.type === "inbound-rtp" && s.kind === "audio").reduce((n, s) => n + (s.packetsReceived ?? 0), 0), frames: all.filter(s => s.type === "inbound-rtp" && s.kind === "video").reduce((n, s) => n + (s.framesDecoded ?? 0), 0), candidates: pairs.map(p => [stats.get(p.localCandidateId)?.candidateType, stats.get(p.remoteCandidateId)?.candidateType]) }); }
  return result;
}); }
async function stopped(p) { return (await media(p)).tracks.every(t => t.state === "ended"); }
async function connected(a, b, video) { await eventually(async () => {
  const data = await Promise.all([media(a), media(b)]);
  return data.every(d => d.connections.some(c => c.state === "connected" && c.audio > 10 && (!video || c.frames > 10) && c.candidates.some(p => p.every(t => t === "relay"))));
}, "real relayed RTP in both directions", 35000); }
async function click(p, name) { await p.getByRole("button", { name, exact: true }).click(); }
async function start(a, b, video = true) { await click(a, video ? "Start video call" : "Start voice call"); await b.getByRole("button", { name: video ? "Accept with camera and microphone" : "Accept with microphone", exact: true }).waitFor(); await click(b, video ? "Accept with camera and microphone" : "Accept with microphone"); await connected(a, b, video); }
async function submit(p, action, fields = {}, selector) {
  const form = p.locator(selector ?? `form[action^='/api/a/${action}?']`).first();
  const details = form.locator("xpath=ancestor::details"); for (let i=0;i<await details.count();i++) if(await details.nth(i).getAttribute("open")===null)await details.nth(i).locator(":scope > summary").click();
  for(const [name,value] of Object.entries(fields)) { const el=form.locator(`[name='${name}']`); if(await el.getAttribute("type")==="checkbox")await el.setChecked(Boolean(value)); else await el.fill(String(value)); }
  await Promise.all([p.waitForNavigation(), form.locator("button").first().click()]); assert.equal(new URL(p.url()).searchParams.get("e"), null);
}
async function screenshots(p, path, label) { for (const lang of ["en", "ru"]) for (const width of [390, 1440]) { await p.setViewportSize({ width, height: 1000 }); await go(p, path.replace("/en/", `/${lang}/`)); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, `${label}/${lang}/${width} overflow`); await p.screenshot({ path: `artifacts/c26-screens/${label}-${lang}-${width}.png`, fullPage: true }); } await p.setViewportSize({width:1440,height:1000}); }
try {
  await mkdir("artifacts/c26-screens", { recursive: true });
  for (const name of ["alice", "bob"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["camera", "microphone"] });
    await context.addCookies([{ name: "mv_session", value: fixture.accounts[name].token, url: BASE, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(() => {
      window.__captures = 0; window.__streams = []; window.__peers = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { window.__captures++; const stream = await original(constraints); window.__streams.push(stream); return stream; };
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native { constructor(config) { super(config); window.__peers.push(this); } };
    });
    const p = await context.newPage(); pages[name] = p;
    p.on("response", async r => { if(new URL(r.url()).pathname === "/api/social/calls") { const req=r.request().postDataJSON(),data=await r.json().catch(()=>({})); events.push({name,action:req.action,kind:req.kind,status:r.status(),error:data.error,call:data.call,signals:data.signals?.map(s=>({id:s.id,kind:s.kind}))}); } });
    p.on("pageerror", e => errors.push(`${name}: ${e.message}`));
    p.on("response", r => { if(r.status() >= 500) errors.push(`${name}: ${r.status()} ${new URL(r.url()).pathname}`); });
  }
  const a=pages.alice,b=pages.bob,path=`/en/dating/${fixture.matchId}`;
  await screenshots(a,path,"call-idle");
  await Promise.all([go(a,path),go(b,path)]);
  deniedBrowser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true,args:["--use-fake-device-for-media-stream"]});
  const deniedContext = await deniedBrowser.newContext();
  await deniedContext.grantPermissions([], { origin: BASE });
  await deniedContext.addCookies([{name:"mv_session",value:fixture.accounts.alice.token,url:BASE,httpOnly:true,sameSite:"Lax"}]);
  const denied = await deniedContext.newPage(); await go(denied,path); await click(denied,"Start voice call");
  await denied.getByText("Microphone or camera permission was not granted.",{exact:true}).waitFor();
  assert.equal((await sql.query("select count(*)::int n from social_calls where match_id=$1 and state<>'ended'",[fixture.matchId])).rows[0].n,0);
  await deniedContext.close();await deniedBrowser.close();deniedBrowser=null;mark("Browser permission denial creates no invitation and returns a recoverable message");
  assert.equal((await media(a)).captures,0);assert.equal((await media(b)).captures,0);mark("Opening conversation never captures microphone or camera");
  const policy=(await a.request.get(BASE+path)).headers()["permissions-policy"];assert.match(policy,/camera=\(self\), microphone=\(self\)/);
  await click(a,"Start video call");await b.getByRole("button",{name:"Accept with camera and microphone",exact:true}).waitFor();assert.equal((await media(b)).captures,0);
  await click(b,"Accept with camera and microphone");await connected(a,b,true);
  for(const p of [a,b]) { const play=p.getByRole("button",{name:"Play participant audio and video",exact:true}); if(await play.count())await play.click(); await eventually(()=>p.locator("video").last().evaluate(v=>!v.paused&&v.readyState>=2),"participant playback"); }
  const proof=await Promise.all([media(a),media(b)]);await writeFile("artifacts/c26-relay-proof.json",JSON.stringify(proof,null,2));
  await click(a,"Mute microphone");assert.equal((await media(a)).tracks.find(t=>t.kind==="audio"&&t.state==="live").enabled,false);await click(a,"Unmute microphone");
  await click(a,"Turn camera off");assert.equal((await media(a)).tracks.find(t=>t.kind==="video"&&t.state==="live").enabled,false);await click(a,"Turn camera on");
  for(const width of [390,1440]) { await a.setViewportSize({width,height:1000});assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);await a.screenshot({path:`artifacts/c26-screens/video-en-${width}.png`,fullPage:true}); }
  await click(a,"End call");await eventually(async()=>await stopped(a)&&await stopped(b),"hangup stops every track");
  assert.equal((await sql.query("select count(*)::int n from social_call_signals s join social_calls c on c.id=s.call_id where c.match_id=$1",[fixture.matchId])).rows[0].n,0);
  mark("Two-context video/audio uses only relay candidates and decoded RTP; mute/camera/hangup work and signalling is erased");
  await Promise.all([go(a,path.replace("/en/","/ru/")),go(b,path.replace("/en/","/ru/"))]);
  await click(a,"Позвонить с видео");await b.getByRole("button",{name:"Принять с камерой и микрофоном",exact:true}).waitFor();await click(b,"Принять с камерой и микрофоном");await connected(a,b,true);
  for(const width of [390,1440]){await a.setViewportSize({width,height:1000});assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);await a.screenshot({path:`artifacts/c26-screens/video-ru-${width}.png`,fullPage:true});}
  await click(a,"Выключить микрофон");await click(a,"Включить микрофон");await click(a,"Выключить камеру");await click(a,"Включить камеру");await click(a,"Завершить звонок");await eventually(async()=>await stopped(a)&&await stopped(b),"Russian call controls");
  await Promise.all([go(a,path),go(b,path)]);mark("Russian voice/video controls complete the same relayed call on mobile and desktop layouts");
  await click(a,"Start voice call");await b.getByRole("button",{name:"Accept with microphone",exact:true}).waitFor();const before=(await media(b)).captures;await click(b,"Decline");await eventually(()=>stopped(a),"decline stops caller media");assert.equal((await media(b)).captures,before);mark("Declining an audio invitation never opens recipient devices");
  await start(a,b,false);assert.ok((await media(a)).tracks.filter(t=>t.state==="live").every(t=>t.kind==="audio"));
  await a.route("**/api/social/calls",r=>r.abort());await eventually(()=>stopped(a),"control loss stops media",16000);await eventually(()=>stopped(b),"missing participant heartbeat ends remote media",35000);await a.unroute("**/api/social/calls");
  mark("Audio-only call receives real RTP; control loss stops local capture and stale heartbeat ends remote call");
  await a.getByRole("button",{name:"Start voice call",exact:true}).waitFor();await start(a,b,false);
  await a.getByRole("link",{name:"← Connections",exact:true}).click();await eventually(()=>stopped(b),"navigation hangup");mark("Leaving conversation closes media and ends the other participant’s call");
  await go(a,path);await start(a,b,true);
  await submit(b,"social.block");await eventually(()=>stopped(a),"block ends remote media");assert.match(await b.locator("body").innerText(),/Conversation closed/);
  mark("Blocking during a connected video call closes conversation, media and invitations");
  await screenshots(a,"/en/dating","discovery");
  const charlie=a.locator(`article:has(input[name='user'][value='${fixture.accounts.charlie.id}'])`),dana=a.locator(`article:has(input[name='user'][value='${fixture.accounts.dana.id}'])`);
  assert.equal(await charlie.locator("[data-gaming-fit]").count(),1);assert.equal(await dana.locator("[data-gaming-fit]").count(),0);
  await go(a,"/en/dating");await submit(a,"social.profile",{gamingConsent:false,consent:true});assert.equal(await a.locator("[data-gaming-fit]").count(),0);
  await submit(a,"social.profile",{gamingConsent:true,consent:true});assert.ok(await a.locator("[data-gaming-fit]").count()>0);
  await a.locator("input[name=city]").last().fill("No city matches");await a.getByRole("button",{name:"Apply filters",exact:true}).click();await a.getByText("No profiles match yet. Adjust the filters or return later.",{exact:true}).waitFor();await a.getByRole("link",{name:"Reset",exact:true}).click();
  await screenshots(b,path,"closed");mark("Optional gaming consent changes real discovery ranking; filters, reset and RU/EN narrow layouts work");
  const guest=await browser.newContext();const outsider=await guest.request.post(BASE+"/api/social/calls",{headers:{Origin:BASE},data:{action:"poll",matchId:fixture.matchId,device:crypto.randomUUID()}});assert.equal(outsider.status(),401);await guest.close();
  const origin=await a.request.post(BASE+"/api/social/calls",{headers:{Origin:"https://untrusted.example"},data:{action:"poll",matchId:fixture.matchId,device:crypto.randomUUID()}});assert.equal(origin.status(),400);
  assert.deepEqual(errors,[]);mark("Unauthenticated and foreign-origin control requests are rejected; no browser runtime errors");
  await writeFile("artifacts/c26-browser-results.json",JSON.stringify({checks,errors},null,2));console.log(`PASS ${checks.length} complete browser scenarios`);
} catch(error) {
  for(const [name,p] of Object.entries(pages)){await p.screenshot({path:`artifacts/c26-screens/failure-${name}.png`,fullPage:true}).catch(()=>{});console.error(name,JSON.stringify(await media(p).catch(()=>({}))),await p.locator("[data-call-status]").allTextContents().catch(()=>[]));}
  await writeFile("artifacts/c26-browser-diagnostic.json",JSON.stringify(events,null,2));
  throw error;
} finally {await deniedBrowser?.close();await browser.close();await sql.end();}
