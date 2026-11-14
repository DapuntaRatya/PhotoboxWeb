import { digest } from './graphics';

export type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
export type AssetKind = 'background' | 'foreground' | 'photo';
type Transfer = { kind: AssetKind; id: string; digest: string; size: number; mime: string };
type PeerEvent = { type: 'asset:ack' | 'asset:request'; kind: AssetKind; id: string };
const maxAsset = 20 * 1024 ** 2;
const chunkSize = 16 * 1024;
const validId = (id: string) => typeof id === 'string' && /^[a-f0-9]{32}(?:[a-f0-9]{32})?$/.test(id);

export class Peer {
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private candidates: RTCIceCandidateInit[] = [];
  private closed = false;
  private sending: Promise<void> = Promise.resolve();
  private receiving: Promise<void> = Promise.resolve();
  private incoming?: { info: Transfer; chunks: ArrayBuffer[]; length: number };
  private audio: MediaStreamTrack | null = null;
  private audioSender?: RTCRtpSender;
  private videoSender?: RTCRtpSender;
  private bitrate = 1_800_000;
  private starting: Promise<void>;
  private disconnectTimer?: number;
  private connectionTimer?: number;

  constructor(config: Promise<RTCConfiguration>, video: MediaStreamTrack, offerer: boolean, private events: {
    signal: (signal: Signal) => void;
    track: (track: MediaStreamTrack) => void;
    status: (status: RTCPeerConnectionState) => void;
    channel: (open: boolean) => void;
    event: (event: PeerEvent) => void;
    asset: (info: Transfer, blob: Blob) => Promise<void>;
    error: (error: unknown) => void;
    relay: (relay: boolean) => void;
  }) {
    this.starting = this.start(config, video, offerer);
    this.starting.catch((error) => {
      if (!this.closed) {
        events.error(error);
        events.status('failed');
      }
    });
  }

  private async start(configuration: Promise<RTCConfiguration>, video: MediaStreamTrack, offerer: boolean) {
    const config = await configuration;
    if (this.closed) return;
    const pc = this.pc = new RTCPeerConnection(config);
    this.connectionTimer = window.setTimeout(() => {
      if (!this.closed && pc.connectionState !== 'connected') this.events.status('failed');
    }, 18_000);
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.events.signal({ candidate: candidate.toJSON() }); };
    pc.ontrack = ({ track }) => this.events.track(track);
    pc.onconnectionstatechange = () => {
      clearTimeout(this.disconnectTimer);
      if (this.closed) return;
      this.events.status(pc.connectionState);
      if (pc.connectionState === 'disconnected') {
        this.disconnectTimer = window.setTimeout(() => this.events.status('failed'), 7000);
      }
      if (pc.connectionState === 'connected') {
        clearTimeout(this.connectionTimer);
        pc.getStats().then((stats) => {
          stats.forEach((report) => {
            if (report.type !== 'transport' || !report.selectedCandidatePairId) return;
            const pair = stats.get(report.selectedCandidatePairId);
            if (pair) this.events.relay([pair.localCandidateId, pair.remoteCandidateId].some((id) => stats.get(id)?.candidateType === 'relay'));
          });
        }).catch(() => {});
      }
    };
    pc.ondatachannel = ({ channel }) => this.setupChannel(channel);
    if (offerer) {
      this.videoSender = pc.addTransceiver(video, {
        direction: 'sendrecv', sendEncodings: [{ maxBitrate: this.bitrate, maxFramerate: 60 }],
      }).sender;
      this.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      await this.audioSender.replaceTrack(this.audio);
      this.setupChannel(pc.createDataChannel('photobox', { ordered: true }));
      await pc.setLocalDescription();
      if (!this.closed) this.events.signal({ description: pc.localDescription!.toJSON() });
    } else {
      // The answer attaches its tracks to the offered transceivers.
      this.answerVideo = video;
    }
  }

  private answerVideo?: MediaStreamTrack;
  private signaling: Promise<void> = Promise.resolve();

  signal(signal: Signal) {
    this.signaling = this.signaling.then(async () => {
      await this.starting;
      const pc = this.pc;
      if (!pc || this.closed) return;
      if (signal.description) {
        await pc.setRemoteDescription(signal.description);
        for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
        if (signal.description.type === 'offer' && this.answerVideo) {
          for (const transceiver of pc.getTransceivers()) {
            transceiver.direction = 'sendrecv';
            if (transceiver.receiver.track.kind === 'video') {
              this.videoSender = transceiver.sender;
              await this.videoSender.replaceTrack(this.answerVideo);
            } else this.audioSender = transceiver.sender;
          }
          await this.audioSender?.replaceTrack(this.audio);
          await pc.setLocalDescription();
          if (!this.closed) this.events.signal({ description: pc.localDescription!.toJSON() });
        }
      } else if (signal.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
        else this.candidates.push(signal.candidate);
      }
      if (pc.signalingState === 'stable') this.applyBitrate();
    }).catch((error) => { if (!this.closed) this.events.error(error); });
  }

  setBitrate(bitrate: number) {
    if (this.bitrate === bitrate) return;
    this.bitrate = bitrate;
    this.applyBitrate();
  }

  private applyBitrate() {
    const sender = this.videoSender;
    const params = sender?.getParameters();
    if (!sender || !params?.encodings.length) return;
    const encoding = params.encodings[0];
    if (encoding.maxBitrate === this.bitrate && encoding.maxFramerate === 60) return;
    encoding.maxBitrate = this.bitrate;
    encoding.maxFramerate = 60;
    params.degradationPreference = 'maintain-framerate';
    void sender.setParameters(params).catch(() => {});
  }

  async setAudio(track: MediaStreamTrack | null) {
    this.audio = track;
    await this.audioSender?.replaceTrack(track);
  }

  private setupChannel(channel: RTCDataChannel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 128 * 1024;
    channel.onopen = () => this.events.channel(true);
    channel.onclose = () => { if (!this.closed) this.events.channel(false); };
    channel.onerror = () => { if (!this.closed) this.events.error(Error('Transfer dengan peserta gagal.')); };
    channel.onmessage = ({ data }) => {
      this.receiving = this.receiving.then(() => this.receive(data)).catch((error) => {
        this.incoming = undefined;
        if (!this.closed) this.events.error(error);
      });
    };
  }

  private async receive(data: string | ArrayBuffer) {
    if (this.closed) return;
    if (typeof data === 'string') {
      if (data.length > 1024) throw Error('Metadata transfer terlalu besar.');
      const meta = JSON.parse(data);
      if (!['background', 'foreground', 'photo'].includes(meta.kind) || !validId(meta.id)) throw Error('Metadata transfer tidak valid.');
      if (meta.type === 'asset:ack' || meta.type === 'asset:request') return this.events.event(meta);
      const mime = meta.kind === 'foreground' ? 'image/png' : 'image/jpeg';
      if (this.incoming || meta.type !== 'asset' || meta.mime !== mime || !/^[a-f0-9]{64}$/.test(meta.digest)
          || !Number.isInteger(meta.size) || meta.size <= 0 || meta.size > maxAsset) throw Error('Ukuran atau format transfer tidak valid.');
      this.incoming = { info: meta, chunks: [], length: 0 };
      return;
    }
    const transfer = this.incoming;
    if (!transfer || !(data instanceof ArrayBuffer) || data.byteLength < 1 || data.byteLength > chunkSize
        || transfer.length + data.byteLength > transfer.info.size) throw Error('Data foto tidak valid.');
    transfer.length += data.byteLength;
    transfer.chunks.push(data);
    if (transfer.length !== transfer.info.size) return;
    this.incoming = undefined;
    const blob = new Blob(transfer.chunks, { type: transfer.info.mime });
    if (await digest(blob) !== transfer.info.digest) throw Error('Pemeriksaan integritas foto gagal.');
    await this.events.asset(transfer.info, blob);
  }

  control(event: PeerEvent) {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(event));
  }

  send(kind: AssetKind, id: string, blob: Blob) {
    const operation = this.sending.then(async () => {
      const channel = this.channel;
      if (!channel || channel.readyState !== 'open' || this.closed) throw Error('Transfer menunggu koneksi peserta.');
      if (blob.size > maxAsset) throw Error('Ukuran foto terlalu besar untuk ditransfer.');
      const checksum = await digest(blob);
      channel.send(JSON.stringify({ type: 'asset', kind, id, digest: checksum, size: blob.size, mime: blob.type }));
      const deadline = performance.now() + 40_000;
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        while (channel.bufferedAmount > 256 * 1024) {
          if (channel.readyState !== 'open' || this.closed || performance.now() >= deadline) throw Error('Transfer foto terputus atau melewati waktu tunggu.');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        channel.send(await blob.slice(offset, offset + chunkSize).arrayBuffer());
      }
    });
    this.sending = operation.catch(() => {});
    return operation;
  }

  close() {
    this.closed = true;
    clearTimeout(this.disconnectTimer);
    clearTimeout(this.connectionTimer);
    this.channel?.close();
    this.pc?.close();
  }
}
