/** Shared public protocol: only integer 0.1-degree cells leave the browser. */
export const NEARBY_CONSENT = "MV-NEARBY-1";
export const NEARBY_RADII = [25, 50, 100, 250] as const;
export type NearbyStatus = { revision: number; active: boolean; expiresAt: string | null; nextUpdateAt: string | null };

export function coarseCell(latitude: number, longitude: number) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error("invalid_location");
  const latCell = Math.round(latitude * 10);
  // Canonical antimeridian and pole representations.
  const lngCell = Math.abs(latCell) === 900 ? 0 : ((Math.round(longitude * 10) + 1800) % 3600 + 3600) % 3600 - 1800;
  return { latCell, lngCell };
}
