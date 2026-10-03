/** Real UI acceptance against the explicitly seeded local fixture; never production. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID, sign } from "node:crypto";
import { chromium } from "playwright-core";
const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) throw new Error("Local fixture only");
const f = JSON.parse(await readFile("artifacts/c24-fixture.json", "utf8")), errors = [], checks = [], expectedOfflineFailures = [];
let offlineWindow = false;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const pages = {};
const mark = s => { checks.push(s); console.log(`PASS ${s}`); };
async function go(p, path) { const r = await p.goto(BASE+path); assert.ok(r && r.status() < 400, `${path}: ${r?.status()}`); await p.waitForLoadState("load"); }
async function submit(p, action, fields = {}, selector) {
  const form = selector ? p.locator(selector) : p.locator(`form[action^='/api/a/${action}?']`).first();
  assert.equal(await form.count(), 1, `${action}: missing form on ${p.url()}`);
  console.log(`CHECK ${action} ${new URL(p.url()).pathname}`);
  const details = form.locator("xpath=ancestor::details");
  for (let i = 0; i < await details.count(); i++) if ((await details.nth(i).getAttribute("open")) === null) await details.nth(i).locator(":scope > summary").click();
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) { for (const v of value) await form.locator(`[name='${name}'][value='${v}']`).check(); continue; }
    const el = form.locator(`[name='${name}']`).first(), type = await el.getAttribute("type");
    if (type === "hidden") assert.equal(await el.inputValue(), String(value));
    else if (type === "checkbox") await el.setChecked(Boolean(value));
    else if (await el.evaluate(e => e.tagName) === "SELECT") await el.selectOption(String(value));
    else await el.fill(String(value));
  }
  await Promise.all([p.waitForNavigation(), form.locator("button:not([type=button])").first().click()]);
  assert.equal(new URL(p.url()).searchParams.get("e"), null, `${action}: ${p.url()}`);
}
async function signed(source, data) {
  const nonce = randomUUID(), timestamp = String(Math.floor(Date.now()/1000)), body = JSON.stringify(data);
  const signature = sign(null, Buffer.from(`MV-STATS-1\n${source}\n${nonce}\n${timestamp}\n${body}`), f.privateKey).toString("base64");
  const response = await fetch(`${BASE}/api/statistics/intake`, { method:"POST", headers:{"Content-Type":"application/json","MV-Stats-Source":source,"MV-Stats-Nonce":nonce,"MV-Stats-Timestamp":timestamp,"MV-Stats-Signature":signature}, body });
  const json = await response.json(); assert.equal(response.status, 200, JSON.stringify(json)); return json;
}
try {
  for (const [name, account] of Object.entries(f.accounts)) {
    const context = await browser.newContext({ viewport: { width:1440, height:1000 }, locale:"en-US" });
    await context.addCookies([{ name:"mv_session", value:account.token, url:BASE, httpOnly:true, sameSite:"Lax" }]);
    const p = await context.newPage(); pages[name] = p;
    p.on("pageerror", e => errors.push(`${name}: ${e.message}`));
    p.on("console", m => { if (m.type()==="error") { const line = `${name}: ${m.text()}`; if (name === "scanner" && offlineWindow && m.text().includes("net::ERR_INTERNET_DISCONNECTED")) expectedOfflineFailures.push(line); else errors.push(line); } });
    p.on("response", r => { if (r.status()>=500) errors.push(`${name}: ${r.status()} ${r.url()}`); });
  }
  const { alice:a, bob:b, owner:o, staff:s, scanner:scan } = pages;
  for (const p of [a,b]) { await go(p,"/en/dating"); await submit(p,"social.profile", { intent:"gaming", age:28, city:"Dubai", game:"cs2", languages:"English", gamingPreferences:"Evening friendly games", relationshipPreferences:"Respectful teammates", bio:"Browser acceptance player looking for friendly teammates", consent:true }); }
  await go(a,"/en/dating"); await submit(a,"social.like",{},`form[action^='/api/a/social.like?']:has(input[value='${f.accounts.bob.user.id}'])`);
  await go(b,"/en/dating"); await submit(b,"social.like",{},`form[action^='/api/a/social.like?']:has(input[value='${f.accounts.alice.user.id}'])`);
  const conversation = new URL(b.url()).pathname;
  await submit(b,"social.message",{body:"Browser message delivered after mutual consent"});
  await go(a,conversation); assert.match(await a.locator("body").innerText(), /Browser message delivered/);
  await submit(a,"social.block"); assert.equal(await a.locator("form[action^='/api/a/social.message?']").count(),0); mark("Mutual discovery → conversation → message → block closes contact");

  await go(a,"/en/progress"); await submit(a,"mission.claim",{},"form[action^='/api/a/mission.claim?']:has(input[value='daily_play'])");
  assert.equal(await a.locator("form[action^='/api/a/mission.claim?']:has(input[value='daily_play']) button").isDisabled(),true);
  await submit(a,"reward.reserve"); assert.match(await a.locator("body").innerText(),/Reserved for collection/);
  await submit(a,"reward.cancel"); assert.match(await a.locator("body").innerText(),/Cancelled/); mark("Confirmed activity → mission claim once → gift reservation and cancellation");

  const venue = `/en/venues/${f.venue.slug}`, workspace = `/en/clubhouse/${f.venue.slug}`;
  await go(o,workspace); await submit(o,"club.station",{name:"Browser station",equipment:"Isolated test station"});
  const day = new Date(Date.now()+86400_000); day.setUTCHours(12,0,0,0);
  const startsAt=day.toISOString().slice(0,16), endsAt=new Date(day.getTime()+3600_000).toISOString().slice(0,16);
  await submit(o,"club.event",{title:"Browser community event",kind:"social",game:"cs2",capacity:1,startsAt,endsAt,description:"Free local fixture event for browser acceptance",freeEntry:true});
  await go(a,venue); await submit(a,"club.rsvp"); await submit(a,"club.book",{startsAt,endsAt});
  await go(b,venue); await submit(b,"club.rsvp"); assert.match(await b.locator("body").innerText(),/Waitlisted/);
  await go(a,venue); await submit(a,"club.rsvp_cancel"); await submit(a,"club.booking_status");
  await go(b,venue); assert.match(await b.locator("body").innerText(),/Reserved/); mark("Station creation → reservation/cancellation; event capacity → waitlist promotion");
  await go(scan,workspace); assert.ok(scan.url().endsWith("/scan"));
  await scan.getByRole("button",{name:"Load venue data",exact:true}).click(); await scan.getByText("Offline admission data loaded for 4 hours.",{exact:true}).waitFor();
  offlineWindow = true; await scan.context().setOffline(true); await scan.locator("input[name=token]").fill(f.pass.token); await scan.getByRole("button",{name:"Record provisional arrival",exact:true}).click();
  await scan.getByText("Pending confirmation",{exact:false}).waitFor(); await scan.context().setOffline(false); offlineWindow = false;
  await scan.getByRole("button",{name:"Synchronise",exact:true}).click(); await scan.getByText("Queue checked against the server. Review results below.",{exact:true}).waitFor();
  assert.match(await scan.locator("ol").last().innerText(),/Confirmed/); await scan.getByRole("button",{name:"Clear device",exact:true}).click(); mark("Venue referee → cached manifest → offline scan → authoritative sync → clear device");

  await go(o,"/en/statistics/sources"); await submit(o,"stats.source",{org:f.org.id,name:"Browser signed source",evidence:"https://example.org/authorised-local-fixture",publicKey:f.publicKey,games:["cs2"]});
  const source = (await o.locator("code").last().innerText()).trim();
  await go(s,"/en/admin?tab=system"); await submit(s,"stats.review",{status:"approved",note:"Independent local fixture source review"});
  await go(a,"/en/statistics"); await submit(a,"stats.link",{source,game:"cs2",handle:"browser-player",consent:true},`form[action^='/api/a/stats.link?']:has(input[name=source][value='${source}'])`);
  const challenge=(await a.locator("code").first().innerText()).trim();
  await signed(source,{kind:"link",game:"cs2",handle:"browser-player",challenge});
  await signed(source,{kind:"match",game:"cs2",handle:"browser-player",matchRef:"browser-match",playedAt:new Date().toISOString(),metrics:{kills:7,deaths:2}});
  await go(o,"/en/statistics/sources"); await submit(o,"stats.record_review",{status:"confirmed",note:"Signed fixture record checked against local scenario"});
  await go(a,"/en/statistics"); assert.match(await a.locator("body").innerText(),/Reviewed by organiser/); await submit(a,"stats.snapshot");
  const download=a.waitForEvent("download"); await a.getByRole("link",{name:"Download records and proof",exact:true}).first().click();
  await (await download).saveAs("artifacts/c24-proof.json"); await a.locator("input[type=file]").setInputFiles("artifacts/c24-proof.json"); await a.getByText(/Record integrity verified/).waitFor();
  await submit(a,"stats.share"); const proofPath=await a.getByRole("link",{name:"Open public proof",exact:true}).getAttribute("href");
  const guest=await browser.newPage(); await go(guest,proofPath); const id=proofPath.split("/").at(-1), publicProof=await (await fetch(`${BASE}/api/statistics/proofs/${id}`)).json();
  assert.equal("records" in publicProof,false); await submit(a,"stats.share"); assert.equal((await fetch(`${BASE}/api/statistics/proofs/${id}`)).status,404);
  await submit(a,"stats.unlink"); mark("Source registration/review → player consent → signed intake → review → snapshot/download/local verification → private sharing");

  await go(o,"/en/cloud-gaming"); await submit(o,"p2p.register",{name:"Browser Arena host",region:"Local",cpu:"Test CPU",gpu:"Test software renderer",ram:16,consent:true});
  const hostPath=new URL(o.url()).pathname;
  await go(s,"/en/admin?tab=system"); await submit(s,"p2p.review",{decision:"approved",note:"Local browser Arena acceptance, no external GPU claim"});
  await go(o,hostPath); await o.getByRole("button",{name:"Accept connections",exact:true}).click(); await o.getByRole("button",{name:"Go offline and end session",exact:true}).waitFor();
  await go(a,"/en/cloud-gaming"); await submit(a,"p2p.allocate",{game:"maximus-arena",region:"Local",consent:true}); const sessionPath=new URL(a.url()).pathname;
  const h=await o.context().newPage(); await go(h,sessionPath);
  await a.getByRole("button",{name:"Connect to host",exact:true}).click(); await h.getByRole("button",{name:"Accept and start streaming",exact:true}).click();
  await a.waitForFunction(()=>{const v=document.querySelector("video");return v && v.videoWidth===960 && v.getVideoPlaybackQuality().totalVideoFrames>8;}, undefined, {timeout:30000});
  await a.getByText(/Session active/).waitFor();
  const paddle=()=>{const c=document.querySelector("canvas"),d=c.getContext("2d").getImageData(0,500,960,1).data;for(let x=0;x<960;x++)if(d[x*4]===139&&d[x*4+1]===111)return x;return -1;};
  const before=await h.evaluate(paddle); await a.getByRole("group",{name:"Game screen; click to control"}).focus(); await a.keyboard.down("ArrowRight"); await h.waitForFunction(paddleSource=>eval(`(${paddleSource})`)()>600,paddle.toString(),{timeout:10000}); await a.keyboard.up("ArrowRight"); assert.ok((await h.evaluate(paddle))>before); mark("P2P approval/allocation → real WebRTC video frames → keyboard input moves host-rendered paddle");
  await a.locator("select").last().selectOption("5"); await a.getByRole("button",{name:"Session delivered — confirm completion",exact:true}).click(); await h.getByRole("button",{name:"Session delivered — confirm completion",exact:true}).click(); await a.getByText(/Session ended/).waitFor(); await h.close();
  await o.getByText("Connect a native host agent",{exact:true}).click(); await o.getByRole("button",{name:"Create or rotate key",exact:true}).click(); await o.locator("input[type=password]").waitFor(); await o.getByRole("button",{name:"Revoke key",exact:true}).click(); await o.getByText("Key revoked",{exact:true}).waitFor(); mark("P2P completion feedback and host-key create/revoke controls");

  await mkdir("artifacts/c24-screens",{recursive:true});
  const englishScreens=[[a,"/en/progress"],[a,"/en/dating"],[a,"/en/statistics"],[o,workspace],[a,venue],[o,"/en/cloud-gaming"],[o,"/en/statistics/sources"],[scan,`${workspace}/scan`]];
  const screens = englishScreens.flatMap(([p,path]) => [[p,path],[p,path.replace("/en/","/ru/")]]);
  for(const [p,path] of screens) for(const width of [390,1440]) { await p.setViewportSize({width,height:900}); await go(p,path); const overflow=await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth); assert.ok(overflow<=1,`${path} width ${width} overflow ${overflow}`); await p.screenshot({path:`artifacts/c24-screens/${path.split("/").slice(1).join("-")}-${width}.png`,fullPage:true}); }
  mark("Eight populated screens in RU/EN at 390/1440 px, no horizontal overflow");
  assert.deepEqual(errors,[]); await writeFile("artifacts/c24-browser-results.json",JSON.stringify({checks,errors,expectedOfflineFailures},null,2)); console.log(`PASS ${checks.length} complete UI scenarios`);
} finally { await browser.close(); }
