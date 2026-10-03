/** Local browser → forms → PostgreSQL → public list/map acceptance. Tiles are intercepted, never fetched. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import pg from "pg";
const BASE = process.env.BASE ?? "http://127.0.0.1:3100", url = process.env.PG_TEST_URL;
if (!url || !['127.0.0.1','localhost'].includes(new URL(BASE).hostname) || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.startsWith('/c28_')) throw Error('Local c28_ database only');
const fixture = JSON.parse(await readFile('artifacts/c28-fixture.json','utf8'));
const sql = new pg.Pool({ connectionString: url }), browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const checks = [], errors = []; let tileRequests = 0, failTiles = false;
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const mark = s => { checks.push(s); console.log(`PASS ${s}`); };
async function page(role) {
  const c = await browser.newContext({ viewport: { width:1440,height:1000 } });
  await c.route('https://tile.openstreetmap.org/**', async route => { tileRequests++; await route.fulfill({ status: failTiles ? 503 : 200, contentType:'image/png', body: failTiles ? Buffer.from('local test failure') : tile }); });
  await c.addInitScript(() => { window.__geoCalls = 0; navigator.geolocation.getCurrentPosition = () => { window.__geoCalls++; throw Error('Unexpected geolocation'); }; });
  if(role) await c.addCookies([{ name:'mv_session',value:fixture.accounts[role].token,url:BASE,httpOnly:true,sameSite:'Lax' }]);
  const p = await c.newPage(); p.setDefaultTimeout(15000); p.setDefaultNavigationTimeout(30000); p.on('pageerror',e=>errors.push(e.message)); p.on('dialog',async d=>{errors.push('Unexpected dialog');await d.dismiss();});
  p.on('response',r=>{if(r.status()>=500 && new URL(r.url()).origin===BASE)errors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
  p.on('console',m=>{if(/same key|unique.*key|hydration|hydrating/i.test(m.text()))errors.push(m.text());});
  return p;
}
const go = async (p,path) => { const r=await p.goto(BASE+path);assert.equal(r.status(),200);await p.waitForLoadState('load'); };
const form = (p,action,id) => p.locator(`form[action^='/api/a/${action}?']${id ? `:has(input[name=venue][value='${id}'])` : ''}`).first();
async function show(f) {const d=f.locator('xpath=ancestor::details');if(await d.count() && await d.getAttribute('open')===null)await d.locator(':scope > summary').click();}
async function submit(p,f,button) {await show(f);await Promise.all([p.waitForNavigation(),(button?f.getByRole('button',{name:button,exact:true}):f.locator('button').first()).click()]);return new URL(p.url()).searchParams;}
const cards=p=>p.locator('[data-venue-results]:visible > a');
const ownerPath=`/en/organizer/${fixture.org.slug}/venues`;
async function fill(f,name,lat='25.200123',lng='55.270123') {
  await show(f);for(const [k,v] of Object.entries({name,address:'Local browser entrance 28',city:'Dubai',latitude:lat,longitude:lng}))await f.locator(`[name=${k}]`).fill(v);
  await f.locator('[name=kind]').selectOption('clubhouse');await f.locator('[name=country]').selectOption('AE');await f.locator('[name=games][value=cs2]').check();
}
async function openMap(p,ru=false) {await p.getByRole('button',{name:ru?'Показать карту':'Show map',exact:true}).click();await p.locator('.venue-map-canvas .leaflet-marker-icon').first().waitFor();}
try {
  await mkdir('artifacts/c28-screens',{recursive:true});
  const guest=await page(),owner=await page('owner'),staff=await page('staff');
  await go(guest,'/en/venues');assert.equal(tileRequests,0);assert.equal(await guest.evaluate(()=>window.__geoCalls),0);assert.ok(await cards(guest).count()>=3);mark('List loads without map requests or device geolocation');
  await go(owner,ownerPath);let f=form(owner,'venue.create');const name=`Browser venue ${fixture.suffix}`;
  await fill(f,name,'25','');assert.equal((await submit(owner,f)).get('e'),'venue_coordinates');
  f=form(owner,'venue.create');await fill(f,name);assert.equal((await submit(owner,f)).get('e'),null);
  const v=(await sql.query('select id,slug,status,lat_e6,lng_e6,games from venues where name=$1',[name])).rows[0];assert.ok(v);assert.equal(v.status,'draft');assert.equal(v.lat_e6,25200123);assert.deepEqual(v.games,['cs2']);
  assert.equal((await guest.goto(BASE+`/en/venues/${v.slug}`)).status(),404);
  assert.equal((await submit(owner,form(owner,'venue.submit',v.id))).get('e'),null);mark('Organizer creates paired coordinates and games; draft stays private and enters review');
  await go(staff,'/en/admin?tab=venues');let review=form(staff,'venue.review',v.id);assert.equal(await review.locator('[name=version]').inputValue(),'0');
  assert.ok(await staff.getByRole('link',{name:'Entrance coordinates: 25.200123, 55.270123 ↗',exact:true}).count());
  await go(owner,ownerPath);f=form(owner,'venue.update',v.id);await show(f);await f.locator('[name=latitude]').fill('25.21');await submit(owner,f);
  assert.equal((await submit(staff,review,'Confirm')).get('e'),'venue_changed');
  review=form(staff,'venue.review',v.id);assert.equal(await review.locator('[name=version]').inputValue(),'1');assert.equal((await submit(staff,review,'Confirm')).get('e'),null);
  assert.equal((await sql.query('select status from venues where id=$1',[v.id])).rows[0].status,'confirmed');mark('Staff sees coordinates and games; stale decision fails, current review publishes');
  await go(guest,'/en/venues');f=guest.getByRole('form',{name:'Clubs and venues'});
  await f.locator('[name=name]').fill(name);await f.locator('[name=game]').selectOption('cs2');await f.locator('[name=city]').fill('Dubai');await f.locator('[name=country]').selectOption('AE');await f.locator('[name=kind]').selectOption('clubhouse');
  await Promise.all([guest.waitForNavigation(),f.getByRole('button',{name:'Show',exact:true}).click()]);assert.equal(await cards(guest).count(),1);assert.equal(tileRequests,0);
  await openMap(guest);assert.ok(tileRequests>0);assert.equal(await guest.locator('.leaflet-marker-icon').count(),1);
  await guest.getByLabel('Show a venue on the map',{exact:true}).selectOption(v.slug);await guest.locator('.leaflet-popup').waitFor();assert.ok((await guest.locator('.leaflet-popup').innerText()).includes(name));
  await guest.getByRole('link',{name:'Open venue',exact:true}).click();await guest.waitForURL(`**/en/venues/${v.slug}`);assert.ok((await guest.getByRole('link',{name:'Open on the map ↗',exact:true}).getAttribute('href')).includes('mlat=25.21'));
  await openMap(guest);await guest.getByRole('button',{name:'Hide map',exact:true}).click();assert.equal(await guest.locator('.leaflet-marker-icon').count(),0);mark('Intersected filters, marker selection, popup link, venue page and map toggle work');
  await go(guest,'/en/venues?game=valorant');await guest.getByText('No venues match these filters.',{exact:true}).waitFor();assert.equal(await guest.getByRole('button',{name:'Show map',exact:true}).count(),0);
  await guest.getByRole('link',{name:'Reset filters',exact:true}).click();await guest.waitForURL('**/en/venues');await cards(guest).first().waitFor();assert.equal(await guest.locator('select[name=game]:visible').inputValue(),'');mark('Empty results and filter reset reflect current inputs and hide unavailable map controls');
  await openMap(guest);await guest.getByLabel('Show a venue on the map',{exact:true}).selectOption(fixture.venues[2].slug);await guest.locator('.leaflet-popup').waitFor();assert.equal(await guest.locator('.leaflet-popup img').count(),0);assert.ok((await guest.locator('.leaflet-popup').innerText()).includes('<img'));
  await guest.getByRole('button',{name:'Hide map',exact:true}).click();failTiles=true;await openMap(guest);await guest.getByText('Map tiles are unavailable. Venue markers and the list remain available.',{exact:true}).waitFor();assert.ok(await cards(guest).count()>0);failTiles=false;mark('Venue text is inert in map popups; tile failure retains markers and venue links');
  const unavailable=await page();await unavailable.route('**/_next/static/chunks/*.js',async route=>{const response=await route.fetch();if((await response.text()).includes('leaflet-pane'))await route.abort();else await route.fulfill({response});});
  await go(unavailable,'/en/venues');await unavailable.getByRole('button',{name:'Show map',exact:true}).click();await unavailable.getByText('The map could not load. The venue list and links remain available below.',{exact:true}).waitFor();assert.ok(await cards(unavailable).count()>0);await unavailable.close();mark('A failed map-library download leaves directory links usable');
  for(const lang of ['ru','en'])for(const width of [390,1440]) {
    for(const [kind,p,path] of [['directory',guest,`/${lang}/venues`],['organizer',owner,`/${lang}/organizer/${fixture.org.slug}/venues`],['review',staff,`/${lang}/admin?tab=venues`]]) {
      await p.setViewportSize({width,height:1000});await go(p,path);if(kind==='directory')await openMap(p,lang==='ru');
      if(kind==='organizer')await show(form(p,'venue.update',v.id));
      assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1,`${kind} ${lang} ${width} overflow`);
      await p.screenshot({path:`artifacts/c28-screens/${kind}-${lang}-${width}.png`,fullPage:true});
    }
  }
  mark('Twelve populated RU/EN directory, organizer and review screens fit 390/1440 px');
  await go(staff,'/en/admin?tab=venues');review=form(staff,'venue.review',v.id);await review.locator('[name=note]').fill('Local acceptance suspension, no real venue');await submit(staff,review,'Suspend');
  await go(guest,`/en/venues?name=${encodeURIComponent(name)}`);assert.equal(await cards(guest).count(),0);assert.equal((await guest.goto(BASE+`/en/venues/${v.slug}`)).status(),404);mark('Suspension removes the venue from directory, map and public detail');
  const outsider=await page('outsider');const denied=await outsider.request.post(BASE+'/api/a/venue.update?lang=en',{form:{lang:'en',back:'/en/venues',venue:v.id,name,kind:'clubhouse',address:'Foreign test 12',city:'Dubai',country:'AE'},maxRedirects:0,headers:{Origin:BASE}});
  assert.ok(denied.headers().location.includes('e=forbidden'));assert.equal((await sql.query('select address from venues where id=$1',[v.id])).rows[0].address,'Local browser entrance 28');
  assert.equal(await guest.evaluate(()=>window.__geoCalls),0);assert.deepEqual(errors,[]);mark('Foreign edits denied, no device location calls or application browser errors');
  await writeFile('artifacts/c28-browser-results.json',JSON.stringify({checks,tileRequests,realTileRequests:0,screenshots:12,errors},null,2));
} finally {await browser.close();await sql.end();}
