import { AccessToken, RoomServiceClient, EgressClient, RoomEgress, RoomCompositeEgressRequest, EncodedFileOutput,
  EncodedFileType, S3Upload, EncodingOptionsPreset, EgressStatus, TrackSource, WebhookReceiver } from "livekit-server-sdk";
import { S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetBucketVersioningCommand, GetPublicAccessBlockCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { broadcastConfig } from "./broadcast-config.ts";
import { fail } from "./errors.ts";

export type ProviderRoom = { name: string; record: boolean; key: string; maxViewers: number };
export type RecordingState = { status: "pending" | "ready" | "failed" | "none"; id?: string; bytes?: number };
export interface BroadcastProvider {
  create(room: ProviderRoom): Promise<{ sid: string }>;
  close(name: string, identities: string[]): Promise<void>;
  recording(name: string, key: string): Promise<RecordingState>;
  remove(key: string): Promise<void>;
  download(key: string, ttl: number): Promise<string>;
  token(name: string, identity: string, publish: boolean, ttl: number): Promise<string>;
  publishing(name: string, identity: string): Promise<boolean>;
  participants(name: string): Promise<string[]>;
  revokeViewer(name: string, identity: string): Promise<void>;
  healthy(): Promise<boolean>;
}

/** Production adapter. Tests supply an explicit provider argument; there is no environment mock mode. */
export function liveBroadcastProvider(): BroadcastProvider {
  const c = broadcastConfig();
  if (!c.ready) return fail("feature_disabled");
  const host = c.url.replace(/^wss:/, "https:");
  const rooms = new RoomServiceClient(host, c.apiKey, c.apiSecret, { requestTimeout: 8 });
  const egress = new EgressClient(host, c.apiKey, c.apiSecret, { requestTimeout: 8 });
  const s3 = new S3Client({ region: c.region, credentials: { accessKeyId: c.accessKey, secretAccessKey: c.secret }, maxAttempts: 2 });
  const terminal = new Set([EgressStatus.EGRESS_COMPLETE, EgressStatus.EGRESS_FAILED, EgressStatus.EGRESS_ABORTED, EgressStatus.EGRESS_LIMIT_REACHED]);
  return {
    async create(r) {
      const room = await rooms.createRoom({ name: r.name, emptyTimeout: 90, departureTimeout: 30,
        maxParticipants: r.maxViewers + 2,
        egress: r.record ? new RoomEgress({ room: new RoomCompositeEgressRequest({ roomName: r.name, layout: "speaker",
          options: { case: "preset", value: EncodingOptionsPreset.H264_720P_30 },
          fileOutputs: [new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath: r.key, disableManifest: true,
            output: { case: "s3", value: new S3Upload({ bucket: c.bucket, region: c.region, accessKey: c.accessKey, secret: c.secret }) } })] }) }) : undefined });
      return { sid: room.sid };
    },
    async close(name, identities) {
      // Delete room and explicitly stop any recorder: neither a tab close nor token expiry stops billing.
      // Cloud revocation covers clients that already left, including automatically refreshed tokens.
      await Promise.all(identities.map(identity => rooms.removeParticipant(name, identity, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 30) })));
      const active = await egress.listEgress({ roomName: name, active: true });
      for (const e of active) await egress.stopEgress(e.egressId);
      if ((await rooms.listRooms([name])).length) await rooms.deleteRoom(name);
    },
    async recording(name, key) {
      const recordings = await egress.listEgress({ roomName: name });
      if (!recordings.length) return { status: "none" };
      if (recordings.some(e => !terminal.has(e.status))) return { status: "pending" };
      if (recordings.length !== 1) return { status: "failed" };
      const e = recordings[0];
      const file = e.fileResults.find(f => f.filename === key);
      if (e.status !== EgressStatus.EGRESS_COMPLETE || !file) return { status: "failed", id: e.egressId };
      const object = await s3.send(new HeadObjectCommand({ Bucket: c.bucket, Key: key }));
      return { status: "ready", id: e.egressId, bytes: object.ContentLength ?? Number(file.size) };
    },
    async remove(key) {
      const current = await s3.send(new GetBucketVersioningCommand({ Bucket: c.bucket }));
      if (current.Status) throw new Error("Versioned archive storage requires reconciliation");
      await s3.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
    },
    async download(key, ttl) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: c.bucket, Key: key, ResponseContentType: "video/mp4",
        ResponseContentDisposition: 'attachment; filename="maximus-pov.mp4"', ResponseCacheControl: "private, no-store" }), { expiresIn: ttl });
    },
    async token(name, identity, publish, ttl) {
      const at = new AccessToken(c.apiKey, c.apiSecret, { identity, ttl });
      at.addGrant({ room: name, roomJoin: true, canPublish: publish, canSubscribe: !publish, canPublishData: false,
        canUpdateOwnMetadata: false, ...(publish ? { canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, TrackSource.MICROPHONE] } : {}) });
      return at.toJwt();
    },
    async publishing(name, identity) {
      return (await rooms.listParticipants(name)).some(p => p.identity === identity && p.tracks.some(t => t.source === TrackSource.SCREEN_SHARE));
    },
    async participants(name) { return (await rooms.listParticipants(name)).map(p => p.identity); },
    async revokeViewer(name, identity) { await rooms.removeParticipant(name, identity, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) }); },
    async healthy() {
      const [versioning, block] = await Promise.all([
        s3.send(new GetBucketVersioningCommand({ Bucket: c.bucket })), s3.send(new GetPublicAccessBlockCommand({ Bucket: c.bucket })), rooms.listRooms(["mv-health-check"]),
      ]);
      const b = block.PublicAccessBlockConfiguration;
      // Versioned buckets need a version-aware eraser. Refuse them instead of leaving old video versions.
      return !versioning.Status && !!b?.BlockPublicAcls && !!b.IgnorePublicAcls && !!b.BlockPublicPolicy && !!b.RestrictPublicBuckets;
    },
  };
}

export async function verifyBroadcastWebhook(raw: string, authorization: string | null) {
  const c = broadcastConfig();
  if (!c.ready || !authorization) fail("forbidden");
  return new WebhookReceiver(c.apiKey, c.apiSecret).receive(raw, authorization!);
}
