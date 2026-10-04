import { json, jsonContext } from "@/server/json-api.ts";
import { errorCode } from "@/server/http.ts";
import { fail } from "@/server/errors.ts";
import { gate } from "@/server/system.ts";
import { roomScope } from "@/server/community.ts";
import { joinVoice, leaveVoice, voiceAvailable, voiceStatus } from "@/server/community-voice.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const { db,user,data } = await jsonContext(request,"community.voice_status",4000);
    const action=String(data.action),device=String(data.device); if(!/^[0-9a-f-]{36}$/i.test(device)) fail("invalid_input");
    if(!["join","leave","status"].includes(action)) fail("invalid_input");
    await gate(db,`community.voice_${action}`,user);
    if(action==="leave") { await leaveVoice(db,user,device); return json({left:true}); }
    const scope=roomScope(data.scope,data.id);
    if(action==="join") return json(await joinVoice(db,user,scope,device));
    return json({available:await voiceAvailable(db),...await voiceStatus(db,user,scope,device)});
  } catch(error) { const code=errorCode(error); if(code==="server_error") console.error("[community-voice] operation failed"); return json({error:code},code==="unauthorized"?401:code==="server_error"?503:400); }
}
