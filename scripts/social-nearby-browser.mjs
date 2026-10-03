/** Complete local browser → API → PostgreSQL → rendered-results acceptance. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import pg from "pg";
const BASE = process.env.BASE ?? "http://127.0.0.1:3100", url = process.env.PG_TEST_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(BASE).hostname) || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !new URL(url).pathname.startsWith('/c27_')) throw Error("Local c27_ browser database only");
const fixture = JSON.parse(await readFile("artifacts/c27-fixture.json", "utf8"));
const sql = new pg.Pool({ connectionString: url });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const checks = [], errors = [], requests = [];
const mark = s => { checks.push(s); console.log(`PASS ${s}`); };
async function context(name, location) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(location ? { geolocation: location, permissions: ['geolocation'] } : {}) });
  await c.addCookies([{ name: "mv_session", value: fixture.accounts[name].token, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(e.message)); p.on('response', r => { if (r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  p.on('request', r => { if (new URL(r.url()).pathname === '/api/social/nearby') requests.push({ name, body: r.postDataJSON() }); });
  return { c, p };
}
async function go(p, path = '/en/dating') { const r = await p.goto(BASE + path); assert.equal(r.status(), 200); await p.waitForLoadState('load'); }
async function click(p, name) { await p.getByRole('button', { name, exact: true }).click(); }
async function enable(p, ru = false) {
  await p.locator('[data-nearby] input[type=checkbox]').check();
  await click(p, ru ? 'Включить поиск поблизости' : 'Enable nearby discovery');
}
async function enabled(p, ru = false) { await p.getByText(ru ? 'Поиск поблизости включён на семь дней. Выберите радиус ниже.' : 'Nearby discovery is enabled for seven days. Choose a radius below.', { exact: true }).waitFor(); }
const card = (p, name) => p.locator(`article:has(input[name='user'][value='${fixture.accounts[name].id}'])`);
async function filter(p, radius) { await p.locator('select[name=radius]').selectOption(radius); await Promise.all([p.waitForNavigation(), click(p, 'Apply filters')]); }
async function submit(p, action, selector) {
  const f = p.locator(selector ?? `form[action^='/api/a/${action}?']`).first();
  const d = f.locator('xpath=ancestor::details'); if (await d.count() && await d.getAttribute('open') === null) await d.locator(':scope > summary').click();
  await Promise.all([p.waitForNavigation(), f.locator('button').first().click()]); assert.equal(new URL(p.url()).searchParams.get('e'), null);
}
async function stored(name) { return (await sql.query('select lat_cell,lng_cell from social_locations where user_id=$1', [fixture.accounts[name].id])).rows; }
async function screenshots(p, suffix, radius = '') {
  for (const lang of ['en', 'ru']) for (const width of [390, 1440]) {
    await p.setViewportSize({ width, height: 1000 }); await go(p, `/${lang}/dating${radius ? `?radius=${radius}` : ''}`);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, `${suffix} ${lang} ${width} overflow`);
    await p.screenshot({ path: `artifacts/c27-screens/${suffix}-${lang}-${width}.png`, fullPage: true });
  }
  await p.setViewportSize({ width: 1440, height: 1000 }); await go(p);
}
try {
  await mkdir('artifacts/c27-screens', { recursive: true });
  const a = await context('alice', { latitude: 25.204849, longitude: 55.270783, accuracy: 10 });
  const b = await context('bob', { latitude: 25.32, longitude: 55.41, accuracy: 10 });
  await a.c.addInitScript(() => { window.__geoCalls = 0; const original = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation); navigator.geolocation.getCurrentPosition = (...args) => { window.__geoCalls++; return original(...args); }; });
  await go(a.p); assert.equal(await a.p.evaluate(() => window.__geoCalls), 0); assert.equal(requests.length, 0);
  assert.equal(await a.p.getByRole('button', { name: 'Enable nearby discovery', exact: true }).isDisabled(), true);
  assert.equal(await a.p.locator('select[name=radius]').isDisabled(), true);
  mark('Opening discovery requests no location; enabling requires separate consent');

  const denied = await context('dana'); await denied.c.grantPermissions([], { origin: BASE });
  await go(denied.p); await enable(denied.p); await denied.p.getByText(/Location permission was denied/).waitFor(); assert.deepEqual(await stored('dana'), []); await denied.c.close();
  const unavailable = await context('dana'); await unavailable.c.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: undefined }));
  await go(unavailable.p); await enable(unavailable.p); await unavailable.p.getByText(/Location is unavailable in this browser/).waitFor(); await unavailable.c.close();
  mark('Permission denial and unsupported browsers preserve city search without uploading a location');

  const late = await context('dana'); await late.c.addInitScript(() => { navigator.geolocation.getCurrentPosition = cb => { window.__lateLocation = cb; }; });
  await go(late.p); await enable(late.p); await click(late.p, 'Delete location and disable'); await late.p.getByText('Location deleted. Nearby discovery is off.', { exact: true }).waitFor();
  await late.p.evaluate(() => window.__lateLocation({ coords: { latitude: 25.204849, longitude: 55.270783, accuracy: 10 } }));
  await late.p.waitForTimeout(100); assert.equal(requests.filter(r => r.name === 'dana' && r.body.action === 'enable').length, 0); await late.c.close();
  mark('Deleting while permission is pending invalidates its late callback');

  await enable(a.p); await enabled(a.p); await go(b.p, '/ru/dating'); await enable(b.p, true); await enabled(b.p, true);
  assert.equal(await a.p.evaluate(() => window.__geoCalls), 1);
  const upload = requests.find(r => r.name === 'alice' && r.body.action === 'enable').body;
  assert.deepEqual(Object.keys(upload).sort(), ['action', 'consent', 'latCell', 'lngCell', 'revision']);
  assert.equal(upload.latCell, 252); assert.equal(upload.lngCell, 553); assert.deepEqual(await stored('alice'), [{ lat_cell: 252, lng_cell: 553 }]);
  const html = await a.p.content(); assert.ok(!html.includes('25.204849') && !html.includes('55.270783') && !html.includes('lat_cell'));
  await go(a.p); assert.equal(await a.p.locator('select[name=radius]').isEnabled(), true);
  mark('RU and EN buttons save only rounded cells; the browser and server agree after reload');

  await filter(a.p, '25'); assert.equal(await card(a.p, 'bob').count(), 1); assert.equal(await card(a.p, 'charlie').count(), 0); assert.equal(await card(a.p, 'dana').count(), 0);
  assert.equal(await card(a.p, 'bob').locator('[data-gaming-fit]').count(), 1);
  await filter(a.p, '100'); assert.equal(await card(a.p, 'charlie').count(), 0);
  await filter(a.p, '250'); assert.equal(await card(a.p, 'charlie').count(), 1);
  await a.p.locator("input[name=city]").last().fill('No matching city'); await Promise.all([a.p.waitForNavigation(), click(a.p, 'Apply filters')]);
  await a.p.getByText('No profiles match yet. Adjust the filters or return later.', { exact: true }).waitFor();
  await a.p.getByRole('link', { name: 'Reset', exact: true }).click(); await card(a.p, 'dana').waitFor(); assert.equal(await a.p.locator('select[name=radius]').inputValue(), ''); assert.equal(await a.p.locator('input[name=city]').last().inputValue(), '');
  await screenshots(a.p, 'active'); await screenshots(a.p, 'radius', '25');
  mark('Radius, city and reset use saved profiles; gaming ranking remains and eight RU/EN screens fit');

  await go(b.p); await submit(b.p, 'social.block', `form[action^='/api/a/social.block?']:has(input[value='${fixture.accounts.alice.id}'])`);
  await go(a.p, '/en/dating?radius=25'); assert.equal(await card(a.p, 'bob').count(), 0);
  await submit(b.p, 'social.unblock'); await go(a.p, '/en/dating?radius=25'); assert.equal(await card(a.p, 'bob').count(), 1);
  mark('Blocking and unblocking in the other account immediately changes nearby results');

  await click(a.p, 'Delete location and disable'); await a.p.getByText('Location deleted. Nearby discovery is off.', { exact: true }).waitFor(); assert.deepEqual(await stored('alice'), []);
  await go(a.p, '/en/dating?radius=25'); await a.p.getByText(/Enable nearby discovery to use a radius/).waitFor(); assert.equal(await a.p.locator('article').count(), 0);
  await a.p.getByRole('link', { name: 'Reset', exact: true }).click(); await card(a.p, 'dana').waitFor(); await enable(a.p); await a.p.getByText(/Location can be updated once an hour/).waitFor(); assert.deepEqual(await stored('alice'), []);
  mark('Opt-out deletes saved location and invalidates radius; toggling cannot bypass the hourly limit');

  await sql.query("update social_profiles set nearby_updated_at=now()-interval '2 hours' where user_id=$1", [fixture.accounts.alice.id]);
  await go(a.p); const second = await a.c.newPage(); await go(second);
  let held; const waiting = new Promise(resolve => { held = resolve; }); let release; const resumed = new Promise(resolve => { release = resolve; });
  await a.p.route('**/api/social/nearby', async r => { if (r.request().postDataJSON().action === 'enable') { held(); await resumed; } await r.continue(); });
  await enable(a.p); await waiting;
  await click(second, 'Delete location and disable'); await second.getByText('Location deleted. Nearby discovery is off.', { exact: true }).waitFor(); release();
  await a.p.getByText(/Settings changed in another tab/).waitFor(); assert.deepEqual(await stored('alice'), []); await a.p.unroute('**/api/social/nearby'); await second.close();
  mark('A delayed upload cannot restore consent revoked in another tab');

  await sql.query("update social_locations set updated_at=now()-interval '8 days',expires_at=now()-interval '1 day' where user_id=$1", [fixture.accounts.bob.id]);
  await go(b.p, '/en/dating?radius=25'); assert.equal(await b.p.locator('article').count(), 0); await b.p.getByText(/Enable nearby discovery to use a radius/).waitFor();
  await screenshots(b.p, 'expired', '25');
  mark('Expired location is excluded immediately and the UI offers fresh consent or reset');

  const guest = await browser.newContext(); const unauth = await guest.request.post(BASE + '/api/social/nearby', { headers: { Origin: BASE }, data: { action: 'disable' } }); assert.equal(unauth.status(), 401); await guest.close();
  const foreign = await a.p.request.post(BASE + '/api/social/nearby', { headers: { Origin: 'https://untrusted.example' }, data: { action: 'disable' } }); assert.equal(foreign.status(), 400);
  const policy = (await a.p.request.get(BASE + '/en/dating')).headers()['permissions-policy']; assert.match(policy, /geolocation=\(self\)/);
  const homePolicy = (await a.p.request.get(BASE + '/en')).headers()['permissions-policy']; assert.match(homePolicy, /geolocation=\(\)/);
  assert.deepEqual(errors, []); mark('Authentication, origin and page permission boundaries hold without runtime errors');
  await writeFile('artifacts/c27-browser-results.json', JSON.stringify({ checks, errors }, null, 2)); console.log(`PASS ${checks.length} complete browser scenarios`);
} finally { await browser.close(); await sql.end(); }
