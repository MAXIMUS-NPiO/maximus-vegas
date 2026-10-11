import {DomainError} from './errors.ts';
/** Read and cap bytes before multipart parsing; Content-Length is only an early optimization. */
export async function boundedFormData(request:Request,maxBytes:number):Promise<FormData>{
 if(Number(request.headers.get('content-length'))>maxBytes)throw new DomainError('file_too_large');
 const reader=request.body?.getReader();if(!reader)throw new DomainError('invalid_input');
 const chunks:Uint8Array[]=[];let bytes=0;
 while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new DomainError('file_too_large');}chunks.push(value);}
 try{return await new Response(Buffer.concat(chunks),{headers:{'content-type':request.headers.get('content-type')??''}}).formData();}catch{throw new DomainError('invalid_input');}
}
