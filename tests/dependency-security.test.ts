import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('temporary path builder rejects non-string traversal prefixes',()=>{const tmp=require('tmp');assert.throws(()=>tmp.tmpNameSync({prefix:['../escape']}));});
test('indexed source maps reject unbounded or noninteger section offsets before iteration',()=>{
 const {SourceMapConsumer}=require('source-map-js');
 for(const line of [Infinity,NaN,-1,1.5,100_000_000])assert.throws(()=>new SourceMapConsumer({version:3,sections:[{offset:{line,column:0},map:{version:3,sources:[],names:[],mappings:''}}]}));
});
