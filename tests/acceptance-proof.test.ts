import test from 'node:test';import assert from 'node:assert/strict';
test('acceptance does not claim success from exit zero without the completed journey marker',async()=>{
 const {assertJourneyCompleted}=await import('../scripts/acceptance-proof.mjs');
 assert.throws(()=>assertJourneyCompleted('scripts/browser-smoke.mjs',0,'sign-up succeeded\n'));
 assert.throws(()=>assertJourneyCompleted('scripts/e2e.mjs',1,'E2E OK against http://127.0.0.1:3112 (run fixture)\n'));
 assert.doesNotThrow(()=>assertJourneyCompleted('scripts/browser-smoke.mjs',0,'BROWSER SMOKE OK against http://127.0.0.1:3112 (run fixture)\n'));
});
