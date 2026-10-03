import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const base=process.env.BASE||'https://www.maximus.vegas';
const results=[];
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 for(const lang of ['ru','en']){
  await page.goto(base+'/'+lang,{waitUntil:'networkidle'});
  const menu=page.locator('button[aria-controls="main-navigation"]');
  await menu.click(); assert.equal(await menu.getAttribute('aria-expanded'),'true');
  await menu.click(); assert.equal(await menu.getAttribute('aria-expanded'),'false');
  results.push(lang+': mobile menu opens/closes');
  const sound=page.locator('button').filter({hasText:lang==='ru'?'Звук':'Sound'}).first();
  const before=await sound.getAttribute('aria-label');await sound.click();
  const after=await sound.getAttribute('aria-label');assert.notEqual(after,before);
  await page.reload({waitUntil:'networkidle'});assert.equal(await sound.getAttribute('aria-label'),after);
  results.push(lang+': sound preference persists');
  for(const slug of ['cs2','dota2','apex','trackmania']){
   const index=['cs2','dota2','apex','trackmania'].indexOf(slug);
   await page.locator('.arena-choice').nth(index).click();
   assert.equal(await page.locator('.arena-choice').nth(index).getAttribute('aria-pressed'),'true');
   assert.match(await page.locator('.arena-primary').getAttribute('href'),new RegExp('game='+slug+'$'));
  }
  results.push(lang+': all game selectors update match target');
  await page.locator('.reaction-target').click();
  assert.equal(await page.locator('.reaction-panel').getAttribute('data-phase'),'waiting');
  await page.locator('.reaction-target').click();
  assert.equal(await page.locator('.reaction-panel').getAttribute('data-phase'),'early');
  results.push(lang+': reaction button responds');
  await page.goto(base+'/'+lang+'/search',{waitUntil:'networkidle'});
  await page.locator('main input[name="q"]').fill('CS2');
  await page.locator('main form button').click();
  await page.waitForURL('**/search?q=CS2');
  results.push(lang+': search form submits');
  await page.goto(base+'/'+lang+'/tournaments',{waitUntil:'networkidle'});
  await page.locator('select[name="game"]').selectOption('pubg');
  const submit=page.locator('main button[type="submit"]');
  if(await submit.count())await submit.first().click();
  else await page.locator('select[name="game"]').press('Enter');
  await page.waitForURL(/game=pubg/);
  results.push(lang+': tournament filter submits');
 }
 console.log(JSON.stringify({passed:results.length,results}));
}finally{await browser.close();}
