import type {Instrumentation} from "next";
export const onRequestError:Instrumentation.onRequestError=async(error,_request,context)=>{
  const {reportError}=await import("./server/observability.ts");
  await reportError("request.unhandled",error,{route:context.routePath});
};
