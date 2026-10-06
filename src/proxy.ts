import {NextRequest,NextResponse} from "next/server";
import {randomBytes} from "node:crypto";
import {contentSecurityPolicy} from "./lib/security-policy.ts";
import {SIGNUP_DEVICE_COOKIE,signupDevice} from "./server/signup-device.ts";
export function proxy(request:NextRequest) {
  const nonce=randomBytes(24).toString("base64");
  const csp=contentSecurityPolicy(nonce,process.env.NODE_ENV!=="production",request.nextUrl.pathname.startsWith("/embed/"));
  const headers=new Headers(request.headers);headers.set("x-nonce",nonce);headers.set("Content-Security-Policy",csp);
  const response=NextResponse.next({request:{headers}});response.headers.set("Content-Security-Policy",csp);
  response.headers.set("Cache-Control","private, no-store");
  if(!signupDevice(request.headers.get("cookie")))response.cookies.set(SIGNUP_DEVICE_COOKIE,randomBytes(24).toString("hex"),{httpOnly:true,secure:request.nextUrl.protocol==="https:",sameSite:"lax",path:"/",maxAge:86400*30});
  return response;
}
export const config={matcher:["/((?!api/|_next/static|_next/image|favicon.ico|brand/|images/|sounds/).*)"]};
