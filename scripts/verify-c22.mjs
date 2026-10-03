import {chromium} from "playwright-core";
import assert from "node:assert/strict";
const BASE="http://127.0.0.1:3222";
const browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
const run=Date.now().toString(36),errors=[];
async function submit(p,action,fields={},specific){const f=specific??p.locator('form[action^="/api/a/'+action+'?"]').first();for(const [k,v] of Object.entries(fields)){const e=f.locator('[name="'+k+'"]');if(await e.getAttribute("type")==="checkbox")await e.check();else if(await e.evaluate(x=>x.tagName)==="SELECT")await e.selectOption(v);else await e.fill(v);}await Promise.all([p.waitForNavigation(),f.locator("button").last().click()]);assert.ok(!new URL(p.url()).searchParams.has("e"),p.url());}
async function account(prefix){const ctx=await browser.newContext({viewport:{width:390,height:844}}),p=await ctx.newPage();p.on("pageerror",e=>errors.push(e.message));await p.goto(BASE+"/en/signup");const name=prefix+run;await submit(p,"auth.signup",{email:name+"@example.com",username:name,displayName:name,password:"Test-password-12345",adult:true,terms:true});return {p,ctx,name};}
try{
 const a=await account("claim"),b=await account("reply");
 await a.p.goto(BASE+"/en/marketplace");await submit(a.p,"marketplace.save",{game:"cs2",title:"Browser test skin",asset:"123456",price:"12.34",currency:"USD"});
 assert.ok((await a.p.locator("body").innerText()).includes("Browser test skin"));await a.p.reload();assert.ok((await a.p.locator("body").innerText()).includes("Browser test skin"));
 await b.p.goto(BASE+"/en/marketplace");assert.ok(!(await b.p.locator("body").innerText()).includes("Browser test skin"));
 await a.p.goto(BASE+"/en/arbitration");await submit(a.p,"arbitration.open",{category:"marketplace",username:b.name,title:"Browser dispute",body:"The agreed delivery did not take place.",evidence:"https://example.com/proof"});
 const caseURL=a.p.url();assert.ok(new URL(caseURL).searchParams.get("case"));
 await b.p.goto(caseURL);await submit(b.p,"arbitration.evidence",{body:"Here is my response to the reported delivery.",evidence:"https://example.com/response"});
 await a.p.reload();assert.ok((await a.p.locator("body").innerText()).includes("Here is my response"));
 await b.p.goto(BASE+"/en/notifications");assert.ok((await b.p.locator("body").innerText()).includes("Arbitration case updated"));
 const guest=await browser.newContext();const g=await guest.newPage();await g.goto(caseURL);assert.ok(!(await g.locator("body").innerText()).includes("The agreed delivery"));
 for(const lang of ["ru","en"]){for(const route of ["arbitration","marketplace"]){for(const width of [390,1440]){await a.p.setViewportSize({width,height:900});await a.p.goto(BASE+"/"+lang+"/"+route);assert.ok(await a.p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),"overflow "+lang+route+width);}}}
 await a.p.goto(BASE+"/en/marketplace");await submit(a.p,"marketplace.delete");assert.ok(!(await a.p.locator("body").innerText()).includes("Browser test skin"));

 await a.p.goto(BASE+"/en/marketplace");await submit(a.p,"marketplace.save",{game:"cs2",title:"Public simulated skin "+run,asset:"sim"+run,price:"25.50",currency:"USD"});
 await submit(a.p,"marketplace.publish");
 await b.p.goto(BASE+"/en/marketplace");assert.ok((await b.p.locator("body").innerText()).includes("Public simulated skin "+run));
 const card=b.p.locator("article").filter({hasText:"Public simulated skin "+run}).first();
 await submit(b.p,"marketplace.request",{},card.locator('form[action^="/api/a/marketplace.request?"]'));
 async function step(p,s){await p.goto(BASE+"/en/marketplace");const f=p.locator('form[action^="/api/a/marketplace.step?"]').filter({has:p.locator('input[name="step"][value="'+s+'"]')}).first();await submit(p,"marketplace.step",{},f);}
 await step(a.p,"accept");await step(b.p,"pay");assert.ok((await b.p.locator("#orders").innerText()).includes("Payment simulated"));
 await step(a.p,"deliver");await step(b.p,"confirm");assert.ok((await b.p.locator("#orders").innerText()).includes("Test transaction completed"));
 await b.p.locator("#orders details summary").first().click();
 await submit(b.p,"arbitration.open",{body:"This is a simulated dispute after delivery."},b.p.locator('#orders form[action^="/api/a/arbitration.open?"]').first());
 assert.ok(new URL(b.p.url()).searchParams.get("case"));
 await a.p.goto(BASE+"/en/marketplace");assert.ok((await a.p.locator("#orders").innerText()).includes("Disputed: actions paused"));
 console.log("PASS: public listing -> buyer request -> seller acceptance -> simulated payment -> simulated delivery -> receipt -> linked arbitration hold.");


 await a.p.goto(BASE+"/en/teams/new");await submit(a.p,"team.create",{name:"Invite flow "+run,tag:"INV",game:"cs2"});
 await submit(a.p,"team.invite",{username:"reserved"+run});
 assert.equal(new URL(a.p.url()).hash,"#invitation-reserved"+run);
 const share=a.p.locator("#invitation-reserved"+run);
 assert.ok((await share.innerText()).includes("has not been sent"));
 await share.getByLabel("Recipient email",{exact:true}).fill("friend@example.com");
 assert.ok((await share.locator('a[href^="mailto:"]').getAttribute("href")).includes("friend%40example.com"));
 await share.getByLabel("Delivery method").selectOption("whatsapp");
 await share.getByLabel("Recipient phone with country code").fill("+971501234567");
 assert.ok((await share.locator('a[href^="https://wa.me/"]').getAttribute("href")).includes("971501234567"));
 await share.getByLabel("Delivery method").selectOption("telegram");assert.ok(await share.locator('a[href^="https://t.me/share/"]').count());
 console.log("PASS: reservation redirects to recipient step; email, WhatsApp and Telegram compose links carry the personal invitation. No messages sent.");

 assert.deepEqual(errors,[]);console.log("PASS: real forms, saved private drafts, party evidence, notifications, guest privacy, RU/EN at phone and desktop widths, no page errors.");
}finally{await browser.close();}
