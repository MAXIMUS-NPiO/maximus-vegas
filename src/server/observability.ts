type Runtime={env?:Partial<NodeJS.ProcessEnv>;fetch?:typeof fetch;sink?:(line:string)=>void};
/** Deliberately never serialize messages, stacks, headers, URLs, bodies, accounts or credentials. */
export async function reportError(event:string,error:unknown,context:{route?:string;requestId?:string}={},runtime:Runtime={}) {
  const env=runtime.env??process.env;
  const e=error&&typeof error==="object"?error as {name?:unknown;code?:unknown;digest?:unknown}:{};
  const safe=(v:unknown,pattern:RegExp,max=100)=>typeof v==="string"&&v.length<=max&&pattern.test(v)?v:undefined;
  const record={timestamp:new Date().toISOString(),level:"error",event:safe(event,/^[a-z0-9_.-]+$/)??"application.error",
    requestId:safe(context.requestId,/^[a-zA-Z0-9_-]+$/)??globalThis.crypto.randomUUID(),route:safe(context.route,/^\/[a-zA-Z0-9_\-/[\].]+$/),
    errorType:safe(e.name,/^(?:[A-Z][a-zA-Z]*Error|Error)$/)??"Error",code:safe(e.code,/^[a-zA-Z0-9_]+$/),digest:safe(e.digest,/^[a-zA-Z0-9_-]+$/)};
  const sink=runtime.sink??(line=>console.error(line));sink(JSON.stringify(record));
  const endpoint=env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;if(!endpoint)return record.requestId;
  try {
    const url=new URL(endpoint);if(url.protocol!=="https:"||url.username||url.password||url.hash)throw new Error("Invalid collector");
    const headers:Record<string,string>={"Content-Type":"application/json"};
    for(const pair of (env.OTEL_EXPORTER_OTLP_HEADERS??"").split(",")) {
      const i=pair.indexOf("=");if(i>0)headers[pair.slice(0,i).trim()]=decodeURIComponent(pair.slice(i+1).trim());
    }
    const body={resourceLogs:[{resource:{attributes:[{key:"service.name",value:{stringValue:"maximus-vegas"}}]},scopeLogs:[{scope:{name:"maximus-vegas.errors"},logRecords:[{
      timeUnixNano:(BigInt(Date.now())*1_000_000n).toString(),severityNumber:17,severityText:"ERROR",body:{stringValue:record.event},
      attributes:Object.entries(record).filter(([,v])=>v!==undefined).map(([key,v])=>({key,value:{stringValue:String(v)}}))}]}]}]};
    const response=await (runtime.fetch??fetch)(url,{method:"POST",headers,body:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(1500)});
    if(!response.ok)throw new Error("Collector refused");
  } catch {sink(JSON.stringify({timestamp:new Date().toISOString(),level:"error",event:"monitoring.export_failed",requestId:record.requestId}));}
  return record.requestId;
}
