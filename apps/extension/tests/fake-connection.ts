/*
 * Just what peer-link.ts calls of WebRTC, for the offscreen document's Node tests; Node has no WebRTC.
 */

export const LOCAL_SDP = "v=0\r\na=fingerprint:sha-256 11:22\r\n";
export const REMOTE_SDP = "v=0\r\na=fingerprint:sha-256 aa:bb\r\n";
export const certificate = {
  expires: Number.MAX_SAFE_INTEGER,
  getFingerprints: () => [
    { algorithm: "sha-1", value: "00:00" },
    { algorithm: "sha-256", value: "ab:cd" },
  ],
} as unknown as RTCCertificate;

export class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  readonly sent: string[] = [];
  send(frame: string) {
    this.sent.push(frame);
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
}

/** Just what the link calls of an RTCPeerConnection, gathering at once; Node has no WebRTC. */
export class FakeConnection extends EventTarget {
  static made: FakeConnection[] = [];
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: { sdp: string } | null = null;
  remoteDescription: { sdp: string } | null = null;
  channel: FakeChannel | undefined;
  readonly config: RTCConfiguration;
  constructor(config: RTCConfiguration) {
    super();
    this.config = config;
    FakeConnection.made.push(this);
  }
  createDataChannel() {
    this.channel = new FakeChannel();
    return this.channel;
  }
  async setLocalDescription() {
    this.signalingState = this.remoteDescription ? "stable" : "have-local-offer";
    this.localDescription = { sdp: LOCAL_SDP };
    this.iceGatheringState = "complete";
  }
  async setRemoteDescription({ sdp }: { sdp: string }) {
    this.remoteDescription = { sdp };
  }
  closed = false;
  close() {
    this.closed = true;
  }
  /** The other side's channel arriving, as the answering side receives it. */
  receiveChannel() {
    this.channel = new FakeChannel();
    this.dispatchEvent(Object.assign(new Event("datachannel"), { channel: this.channel }));
    return this.channel;
  }
}
