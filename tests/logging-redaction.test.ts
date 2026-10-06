import test from 'node:test';import assert from 'node:assert/strict';
import {jsonError} from '../src/server/json-api.ts';
test('caught JSON API exceptions produce structured logs without leaking exception text',async()=>{
 const old=console.error;const logs:unknown[][]=[];console.error=(...args)=>{logs.push(args);};
 try {const response=await jsonError(new Error('password=private-value'));assert.equal(response.status,503);assert.equal(logs.length,1);const serialized=logs.map(args=>args.map(x=>x instanceof Error?x.message:String(x)).join(' ')).join('\n');assert.doesNotMatch(serialized,/private-value|password/);assert.equal(JSON.parse(String(logs[0][0])).event,'api.failure');}finally{console.error=old;}
});
