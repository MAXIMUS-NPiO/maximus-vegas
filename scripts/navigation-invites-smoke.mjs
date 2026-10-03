// Verify navigation and reserved-name sharing on an isolated local database.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
assert(['127.0.0.1', 'localhost'].includes(new URL(BASE).hostname), 'Local test server required');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('response', r => { if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`); });
async function fit(label) {
  const bad = await page.locator('.site-header').evaluate(el => {
    const width = document.documentElement.clientWidth;
    return [...el.querySelectorAll('.brand-link, .header-actions, .nav-group > summary, .nav-panel')].filter(e => {
      if (!e.checkVisibility()) return false;
      const r = e.getBoundingClientRect(); return r.left < -1 || r.right > width + 1;
    }).map(e => e.className);
  });
  assert.deepEqual(bad, [], label);
}
async function navigation(label) {
  for (const lang of ['ru', 'en']) {
    for (const width of [360, 390, 768, 960, 961, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE}/${lang}`);
      await fit(`${label} ${lang} ${width}`);
      const mobile = page.locator('.menu-toggle');
      if (width <= 960) await mobile.click();
      const summaries = page.locator('.nav-group > summary');
      for (let i = 0; i < await summaries.count(); i++) {
        await summaries.nth(i).click();
        assert.equal(await page.locator('.nav-group[open]').count(), 1);
        await fit(`${label} ${lang} ${width} panel ${i}`);
      }
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.site-header details[open]').count(), 0);
      if (width <= 960) {
        assert.equal(await mobile.getAttribute('aria-expanded'), 'false');
        await mobile.click();
        const account = page.locator('.account-menu > summary');
        if (await account.count()) {
          await account.click();
          await page.waitForFunction(() => document.querySelector('.menu-toggle').getAttribute('aria-expanded') === 'false');
          assert.equal(await mobile.getAttribute('aria-expanded'), 'false');
          await mobile.click();
          assert.equal(await page.locator('.account-menu[open]').count(), 0);
        }
        await page.mouse.click(4, 895);
        assert.equal(await mobile.getAttribute('aria-expanded'), 'false');
        await page.locator('.brand-link').click();
        await page.keyboard.press('Escape');
      } else {
        const metrics = await page.evaluate(() => ({ header: document.querySelector('.site-header').getBoundingClientRect().height, padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) }));
        assert(metrics.padding >= metrics.header, `${label} ${lang} ${width}: anchor padding clears sticky header`);
      }
    }
  }
  console.log(`${label}: navigation fits RU/EN at eight widths; panels and Escape verified`);
}
async function submit(action, fields) {
  const form = page.locator(`form[action^="/api/a/${action}?"]`).first();
  for (const [name, value] of Object.entries(fields)) {
    const input = form.locator(`[name="${name}"]`);
    if (typeof value === 'boolean') await input.setChecked(value);
    else if (await input.evaluate(el => el.tagName) === 'SELECT') await input.selectOption(value);
    else await input.fill(value);
  }
  await Promise.all([page.waitForNavigation(), form.locator('button[type=submit], button:not([type])').first().click()]);
  assert.equal(new URL(page.url()).searchParams.get('e'), null, `${action}: ${page.url()}`);
}
try {
  await navigation('guest');
  const run = Date.now().toString(36);
  await page.goto(`${BASE}/ru/signup`);
  await submit('auth.signup', { email: `c23_${run}@example.com`, username: `c23_${run}`, displayName: 'Navigation Test', password: `local-test-${run}`, adult: true, terms: true });
  await navigation('signed in');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE}/ru/teams/new`);
  await submit('team.create', { name: `Invite Team ${run}`, tag: 'C23', game: 'cs2' });
  const teamPath = new URL(page.url()).pathname;
  const username = `guest_${run}`;
  await submit('team.invite', { username });
  const invitation = page.locator(`#invitation-${username}`);
  const delivery = invitation.getByLabel('Способ отправки');
  for (const [channel, name, url] of [['discord', 'Discord', 'https://discord.com/channels/@me'], ['steam', 'Steam', 'https://steamcommunity.com/chat/']]) {
    await delivery.selectOption(channel);
    const text = await invitation.getByLabel('Текст приглашения').inputValue();
    assert(text.includes(`@${username}`));
    assert(text.includes('signup?reservation='));
    await invitation.getByRole('button', { name: 'Копировать приглашение' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
    const link = invitation.getByRole('link', { name: `Открыть ${name}` });
    assert.equal(await link.getAttribute('href'), url);
    assert.equal(await link.getAttribute('target'), '_blank');
  }
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('Clipboard denied')) }));
  await invitation.getByRole('button', { name: 'Копировать приглашение' }).click();
  assert.match(await invitation.getByRole('status').innerText(), /вручную/);
  const selection = await invitation.getByLabel('Текст приглашения').evaluate(el => [el.selectionStart, el.selectionEnd, el.value.length]);
  assert.deepEqual(selection, [0, selection[2], selection[2]]);
  await delivery.selectOption('email');
  await invitation.getByLabel('Email получателя').fill('player@example.com');
  assert.match(await invitation.getByRole('link', { name: 'Открыть письмо для отправки' }).getAttribute('href'), /^mailto:player%40example.com/);
  await delivery.selectOption('whatsapp');
  await invitation.getByLabel('Номер получателя с кодом страны').fill('+971500000000');
  assert.match(await invitation.getByRole('link', { name: 'Открыть WhatsApp' }).getAttribute('href'), /^https:\/\/wa.me\/971500000000\?text=/);
  await delivery.selectOption('telegram');
  assert.match(await invitation.getByRole('link', { name: 'Открыть Telegram' }).getAttribute('href'), /^https:\/\/t.me\/share\/url/);
  await page.goto(BASE + teamPath.replace('/ru/', '/en/'));
  await page.getByLabel('Delivery method').selectOption('steam');
  assert.match(await page.getByLabel('Invitation text').inputValue(), /Join my team/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('Invitation: reservation → Discord/Steam copy; manual fallback; email/WhatsApp/Telegram preserved; RU/EN checked. No messages sent.');
  assert.deepEqual(problems, []);
} finally { await browser.close(); }
