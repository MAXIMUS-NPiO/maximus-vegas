"use client";
import { useState } from "react";
export function MemberAvatar({ name, mediaId, size = "", color }: { name: string; mediaId?: string | null; size?: "" | "lg" | "xl"; color?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className={`avatar${size ? ` avatar-${size}` : ""}`} aria-hidden="true" style={{ overflow: "hidden", flexShrink: 0, background: color || undefined }}>
    {mediaId && failed !== mediaId ? <img src={`/api/media/${mediaId}`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setFailed(mediaId)} /> : name.slice(0, 1).toUpperCase()}
  </span>;
}
