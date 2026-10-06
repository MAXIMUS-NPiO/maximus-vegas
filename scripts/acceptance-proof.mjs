export function assertJourneyCompleted(script,code,output){
 const marker=script.endsWith('/e2e.mjs')?'E2E OK against ':script.endsWith('/browser-smoke.mjs')?'BROWSER SMOKE OK against ':null;
 if(code!==0||!marker||!output.split('\n').some(line=>line.startsWith(marker)))throw new Error(`${script}: incomplete acceptance (exit ${code})`);
}
