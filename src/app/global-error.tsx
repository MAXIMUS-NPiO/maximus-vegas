"use client";
import {ErrorRecovery} from "../components/error-recovery";
export default function GlobalError(props:{error:Error&{digest?:string};retry:()=>void}) {
  return <html lang="en"><body><ErrorRecovery {...props}/></body></html>;
}
