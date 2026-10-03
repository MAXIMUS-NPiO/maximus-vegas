import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors=[], results=[];
try {
 for(const width of [390,1440]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
  for(const lang of ['ru','en']) {
   for(const path of ['', '/games/trackmania','/games/pubg','/rankings?game=trackmania','/partners','/status']) {
    const response=await page.goto('http://127.0.0.1:3218/'+lang+path,{waitUntil:'networkidle'});
    assert.equal(response.status(),200,path);
    const main=page.locator('main');
    const text=await main.innerText();
    assert.ok(text.length>60);
    assert.equal(await page.locator('[data-nextjs-dialog]').count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),path+' overflow '+width);
    if(path==='/games/trackmania') assert.doesNotMatch(text,/kill|убий|battle royale|королевск/i);
    if(path.startsWith('/rankings')) assert.equal(await page.locator('nav.chips a').count(),16);
    if(path==='/partners') {
     const available=await page.locator('ul.checks').innerText();
     const pending=await page.locator('ul.bullets').innerText();
     assert.match(available,/API/);
     assert.match(available,/FFA/);
     assert.doesNotMatch(pending,/^(API|Partner API|FFA|Formats:|Форматы:)/m);
    }
    results.push({lang,path,width,status:response.status()});
   }
  }
  await page.close();
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({pages:results.length,errors,results},null,2));
} finally {await browser.close();}
