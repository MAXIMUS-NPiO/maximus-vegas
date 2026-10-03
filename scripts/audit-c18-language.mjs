import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const path of ['/search?q=CS2','/tournaments?game=pubg&filter=open','/rankings?game=trackmania']){
  await page.goto('http://127.0.0.1:3219/ru'+path,{waitUntil:'networkidle'});
  await page.locator('.lang-switch').click();
  await page.waitForURL('**/en'+path);
  assert.equal(new URL(page.url()).search,new URL('http://x'+path).search);
  await page.locator('.lang-switch').click();await page.waitForURL('**/ru'+path);
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: RU/EN round trips retain search and game filters; no page errors');
}finally{await browser.close();}
