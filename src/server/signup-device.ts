import {isIP} from "node:net";
export const SIGNUP_DEVICE_COOKIE="mv_signup_device";
/** An opaque browser budget, not proof of a physical device or a person's identity. */
export function signupDevice(cookie:string|null) {
  const value=(cookie??"").split(";").map(x=>x.trim()).find(x=>x.startsWith(`${SIGNUP_DEVICE_COOKIE}=`))?.split("=")[1];
  return value && /^[a-f0-9]{48}$/.test(value)?value:undefined;
}
export function signupAddress(request:Request,env:Partial<NodeJS.ProcessEnv>=process.env) {
  // Self-hosters must explicitly confirm their proxy overwrites forwarded headers.
  const raw=env.VERCEL ? request.headers.get("x-vercel-forwarded-for") : env.TRUST_SIGNUP_PROXY==="1" ? request.headers.get("x-forwarded-for") : null;
  const address=raw?.split(",")[0].trim()??"";
  return isIP(address)?address:"unknown-address";
}
