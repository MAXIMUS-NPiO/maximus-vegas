function origin(raw:string|undefined,protocols:string[]) {
  if(!raw) return "";
  const u=new URL(raw);if(!protocols.includes(u.protocol)||u.username||u.password) throw new Error("Invalid CSP service origin");
  return u.origin;
}
export function contentSecurityPolicy(nonce:string,development:boolean,embed:boolean,env:Partial<NodeJS.ProcessEnv>=process.env) {
  if(!/^[a-zA-Z0-9+/=_-]{24,128}$/.test(nonce)) throw new Error("Invalid nonce");
  const relay=origin(env.LIVEKIT_URL,["wss:"]);
  const gateway=origin(env.MPGS_GATEWAY_URL,["https:"]);
  return ["default-src 'self'",`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development?" 'unsafe-eval'":""}`,
    "style-src 'self' 'unsafe-inline'", // Existing inline layout/Leaflet styles; no inline-script allowance.
    "img-src 'self' data: blob: https:","font-src 'self'","object-src 'none'","base-uri 'self'",
    `connect-src 'self' ${relay}${development?" ws: http://localhost:* http://127.0.0.1:*":""}`,
    "media-src 'self' blob: https:","worker-src 'self' blob:",
    "frame-src https://player.twitch.tv https://www.youtube.com https://www.youtube-nocookie.com https://player.kick.com",
    `form-action 'self' https://steamcommunity.com https://checkout.stripe.com ${gateway}`,
    `frame-ancestors ${embed?"*":"'none'"}`,
    ...(!development?["upgrade-insecure-requests"]:[])].join("; ");
}
