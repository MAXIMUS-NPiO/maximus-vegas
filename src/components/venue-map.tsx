"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import type { Locale } from "@/lib/i18n.ts";
import type { VenueMapPoint } from "@/lib/venue-discovery.ts";
import { venueText } from "@/lib/venue-text.ts";
import "leaflet/dist/leaflet.css";
import "./venue-map.css";

/** Map code and third-party tiles are requested only after the visitor opens the map. */
export function VenueMap({ lang, points }: { lang: Locale; points: VenueMapPoint[] }) {
  const [open, setOpen] = useState(false), id = useId(), x = venueText[lang];
  if (!points.length) return <p className="small muted">{x.noMapPoints}</p>;
  return <section className="venue-map-section stack-sm" data-venue-map>
    <div><button type="button" className="btn btn-ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}>{open ? x.hideMap : x.showMap}</button></div>
    <p className="small muted">{open ? x.mapPartial : x.mapLead}</p>
    <div id={id}>{open && <MapCanvas lang={lang} points={points} />}</div>
  </section>;
}

function MapCanvas({ lang, points }: { lang: Locale; points: VenueMapPoint[] }) {
  const root = useRef<HTMLDivElement>(null), map = useRef<LeafletMap | null>(null), markers = useRef<globalThis.Map<string, Marker>>(new globalThis.Map());
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading"), [tileError, setTileError] = useState(false);
  const x = venueText[lang];
  useEffect(() => {
    let disposed = false;
    setState("loading"); setTileError(false);
    void import("leaflet").then(L => {
      if (disposed || !root.current) return;
      const m = L.map(root.current, { scrollWheelZoom: false, zoomControl: false, worldCopyJump: true });
      map.current = m;
      L.control.zoom({ zoomInTitle: x.zoomIn, zoomOutTitle: x.zoomOut }).addTo(m);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
      }).on("tileerror", () => { if (!disposed) setTileError(true); }).addTo(m);
      for (const [i, p] of points.entries()) {
        const icon = L.divIcon({ className: "venue-map-pin", html: `<span>${i + 1}</span>`, iconSize: [30, 30], iconAnchor: [15, 30] });
        const marker = L.marker([p.lat, p.lng], { icon, title: p.name, alt: p.name, keyboard: true }).addTo(m);
        const box = document.createElement("div"), name = document.createElement("strong"), address = document.createElement("p"), link = document.createElement("a");
        // Venue-supplied text must never be interpreted as popup HTML.
        name.textContent = p.name; address.textContent = `${p.address}, ${p.city}`;
        link.textContent = x.mapOpen; link.href = `/${lang}/venues/${encodeURIComponent(p.slug)}`;
        box.append(name, address, link); marker.bindPopup(box); markers.current.set(p.slug, marker);
      }
      m.fitBounds(points.map(p => [p.lat, p.lng] as [number, number]), { padding: [32, 32], maxZoom: 14, animate: false });
      setState("ready");
    }).catch(() => { if (!disposed) { map.current?.remove(); map.current = null; setState("failed"); } });
    const markerIndex = markers.current;
    return () => { disposed = true; map.current?.remove(); map.current = null; markerIndex.clear(); };
  }, [lang, points, x.mapOpen, x.zoomIn, x.zoomOut]);
  return <div className="stack-sm">
    {state === "loading" && <p role="status">{x.mapLoading}</p>}
    {state === "failed" && <p role="status">{x.mapError}</p>}
    {tileError && <p className="notice small" role="status">{x.tileError}</p>}
    {state === "ready" && <label className="field"><span>{x.mapSelect}</span><select aria-label={x.mapSelect} defaultValue="" onChange={e => {
      const m = map.current, marker = markers.current.get(e.target.value); if (!m) return;
      if (marker) { m.setView(marker.getLatLng(), 16, { animate: false }); marker.openPopup(); }
      else { m.closePopup(); m.fitBounds(points.map(p => [p.lat, p.lng] as [number, number]), { padding: [32, 32], maxZoom: 14, animate: false }); }
    }}><option value="">{x.mapAll}</option>{points.map((p, i) => <option key={p.slug} value={p.slug}>{i + 1}. {p.name}</option>)}</select></label>}
    <div ref={root} className="venue-map-canvas" hidden={state === "failed"} role="region" aria-label={x.showMap} />
  </div>;
}
