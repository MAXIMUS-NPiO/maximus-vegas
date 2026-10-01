"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Plays a stream on the portal only after a click: nothing from the platform loads before that (MV-MEDIA-1). */
export function StreamPlayer({ src, title, play, note }: { src: string; title: string; play: string; note: string }) {
  const [on, setOn] = useState(false);
  if (!on)
    return (
      <div className="stream-facade">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setOn(true)}>
          ▶ {play}
        </button>
        <span className="small muted">{note}</span>
      </div>
    );
  return (
    <div className="stream-frame">
      <iframe src={src} title={title} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
    </div>
  );
}

/** Re-reads the page's server data every few seconds (overlays in a broadcast tool). */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
