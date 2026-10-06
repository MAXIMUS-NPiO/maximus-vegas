import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
test("CSP protects every page with a nonce and preserves deliberate media/widget features",async()=>{
  const {contentSecurityPolicy}=await import("../src/lib/security-policy.ts");
  const policy=contentSecurityPolicy("a".repeat(32),false,false,{LIVEKIT_URL:"wss://relay.example.test"});
  assert.match(policy,/nonce-aaaaaaaa/);assert.match(policy,/strict-dynamic/);
  assert.doesNotMatch(policy,/unsafe-eval/);assert.match(policy,/object-src 'none'/);assert.match(policy,/frame-ancestors 'none'/);
  assert.match(policy,/wss:\/\/relay.example.test/);assert.match(contentSecurityPolicy("b".repeat(32),false,true,{}),/frame-ancestors \*/);
  assert.throws(()=>contentSecurityPolicy("a;evil",false,false,{}));
});
test("error boundaries offer safe bilingual recovery without leaking error messages",async()=>{
  const {errorRecovery}=await import("../src/lib/error-recovery.ts");
  const view=errorRecovery("/ru/tournaments",{message:"password=secret",digest:"safe-123"});
  assert.equal(view.home,"/ru");assert.ok(view.retry);assert.equal(view.reference,"safe-123");assert.doesNotMatch(JSON.stringify(view),/password|secret/);
  assert.equal(errorRecovery("/en",{digest:"<script>"}).reference,null);
  for(const file of ["../src/app/error.tsx","../src/app/global-error.tsx"])
    assert.ok(existsSync(new URL(file,import.meta.url)));
});
test("structured logging exports bounded OTLP metadata without secrets or personal data",async()=>{
  const {reportError}=await import("../src/server/observability.ts");
  const captured:string[]=[];let sent:any;
  await reportError("test.failure",new Error("secret token and email person@example.test"),{route:"/api/a/[action]"},{
    env:{OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:"https://collector.example.test/v1/logs"},
    sink:s=>captured.push(s),fetch:async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(null,{status:200});}
  });
  assert.ok(sent.resourceLogs[0].scopeLogs[0].logRecords[0]);
  assert.doesNotMatch(JSON.stringify([captured,sent]),/secret|person@example|token and/);
  assert.equal(JSON.parse(captured[0]).event,"test.failure");
});
test("community and broadcast cleanup run every minute in Vercel configuration",()=>{
  const cfg=JSON.parse(readFileSync(new URL("../vercel.json",import.meta.url),"utf8"));
  for(const path of ["/api/cron/community","/api/cron/broadcasts"])assert.equal(cfg.crons.find((x:any)=>x.path===path)?.schedule,"* * * * *");
});
