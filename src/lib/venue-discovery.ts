/** Public venue locations are unrelated to members' private nearby-discovery cells. */
export const VENUE_LAT_MAX = 85.051128;
export type VenueFilters = { name: string; city: string; country: string; game: string; kind: string };
export type VenueMapPoint = { slug: string; name: string; address: string; city: string; lat: number; lng: number };

export function venueMapPoints(rows: { status: string; slug: string; name: string; address: string; city: string; lat_e6: number | null; lng_e6: number | null }[]): VenueMapPoint[] {
  return rows.flatMap(v => v.status === "confirmed" && v.lat_e6 !== null && v.lng_e6 !== null
    ? [{ slug: v.slug, name: v.name, address: v.address, city: v.city, lat: v.lat_e6 / 1e6, lng: v.lng_e6 / 1e6 }] : []);
}

export function venueCoordinateLink(lat: number, lng: number) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}
