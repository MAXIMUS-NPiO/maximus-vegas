import test from 'node:test';import assert from 'node:assert/strict';
test('multipart parser rejects streamed overflow even without Content-Length',async()=>{
 const {boundedFormData}=await import('../src/server/request-body.ts');
 let cancelled=false;let reads=0;
 const body=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(2048));},cancel(){cancelled=true;}});
 const request=new Request('https://example.test',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=x'},body,duplex:'half'} as RequestInit);
 await assert.rejects(boundedFormData(request,4096),e=>Boolean(e&&typeof e==='object'&&'code' in e&&e.code==='file_too_large'));assert.ok(cancelled);assert.ok(reads<=4);
});
test('multipart parser preserves a legitimate image and repeated fields',async()=>{
 const {boundedFormData}=await import('../src/server/request-body.ts');const input=new FormData();input.append('tags','one');input.append('tags','two');input.append('file',new File(['imagebytes'],'file.png',{type:'image/png'}));
 const output=await boundedFormData(new Request('https://example.test',{method:'POST',body:input}),4096);assert.deepEqual(output.getAll('tags'),['one','two']);assert.equal(await (output.get('file') as File).text(),'imagebytes');
});
