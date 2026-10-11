import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {onRequestError} from "../src/instrumentation.ts";

const require=createRequire(import.meta.url);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test("Node request instrumentation generates an ID and excludes request and exception secrets",async()=>{
  const lines:string[]=[];
  const previousSink=console.error;
  const previousEndpoint=process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  console.error=(line:string)=>{lines.push(line);};
  try {
    await onRequestError(new Error("private exception person@example.test"),{
      path:"/private?token=secret",method:"POST",headers:{authorization:"Bearer secret"}
    },{
      routePath:"/api/a/[action]",routerKind:"App Router",routeType:"route"
    } as Parameters<typeof onRequestError>[2]);
  } finally {
    console.error=previousSink;
    if(previousEndpoint===undefined)delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=previousEndpoint;
  }
  assert.equal(lines.length,1);
  const record=JSON.parse(lines[0]);
  assert.match(record.requestId,uuid);
  assert.equal(record.event,"request.unhandled");
  assert.equal(record.route,"/api/a/[action]");
  assert.doesNotMatch(lines.join("\n"),/private exception|person@example|Bearer|secret|authorization/);
});

test("Next Edge runtime reports sanitized errors and bounds a stalled collector",{timeout:15000},async()=>{
  const {EdgeRuntime}=require("next/dist/compiled/edge-runtime");
  const ts=require("typescript");
  const source=readFileSync(new URL("../src/server/observability.ts",import.meta.url),"utf8");
  const compiled=ts.transpileModule(source,{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText;
  // Use the actual Next Edge VM. No require, Node crypto or UUID substitute is supplied.
  const edge=new EdgeRuntime({initialCode:"const exports={}; const process={env:{}};\n"+compiled+"\nglobalThis.reportError=exports.reportError;"});
  const result=await edge.evaluate(`(async()=>{
    const lines=[];
    let exported;
    const env={OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:"https://collector.example.test/v1/logs"};
    const requestId=await reportError("edge.failure",new Error("private exception person@example.test"),{route:"/api/test"},{
      env,sink:line=>lines.push(line),fetch:async(_url,init)=>{
        exported=JSON.parse(init.body);return new Response(null,{status:200});
      }
    });
    let aborted=false;
    const started=performance.now();
    const failureId=await reportError("edge.timeout",new Error("secret"),{},{
      env,sink:line=>lines.push(line),fetch:async(_url,init)=>{
        await new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>{
          aborted=true;reject(new Error("private collector exception"));
        },{once:true}));
        return new Response(null,{status:200});
      }
    });
    return {requestId,failureId,lines,exported,aborted,elapsed:performance.now()-started};
  })()`);
  assert.match(result.requestId,uuid);
  assert.match(result.failureId,uuid);
  assert.notEqual(result.requestId,result.failureId);
  assert.equal(result.aborted,true);
  assert.ok(result.elapsed<10000,"collector timeout must remain bounded");
  assert.equal(result.lines.length,3);
  assert.equal(JSON.parse(result.lines[2]).event,"monitoring.export_failed");
  assert.equal(JSON.parse(result.lines[2]).requestId,result.failureId);
  assert.ok(result.exported.resourceLogs[0].scopeLogs[0].logRecords[0]);
  assert.doesNotMatch(JSON.stringify(result),/private exception|person@example|secret|private collector/);
});
