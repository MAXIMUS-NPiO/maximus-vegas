import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
test('readiness separates text chat, voice and native studio without claiming live acceptance',async()=>{
 const {componentReadiness}=await import('../src/lib/component-readiness.ts');
 const rows=componentReadiness(false,false,false);assert.deepEqual(rows.map(x=>x.id),['text-chat','voice','native-studio','pubg']);assert.ok(rows.every(x=>x.state!=='works'));
 const enabled=componentReadiness(true,true,true);assert.equal(enabled[0].state,'works');assert.match(enabled[1].note.en,/acceptance/i);assert.match(enabled[3].note.en,/NOT live-verified/);
});
test('handoff preserves approved payment model and retained sponsor action',()=>{
 for(const path of ['README.md','docs/RUNBOOK.md','docs/QA_REMEDIATION.md']){const s=readFileSync(new URL('../'+path,import.meta.url),'utf8');assert.match(s,/Maximus Sports/);assert.match(s,/TEST MODE/);}
 const route=readFileSync(new URL('../src/app/api/a/[action]/route.ts',import.meta.url),'utf8');assert.match(route,/"sponsor.toggle"/);
});
