import type { HandLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
import { Draft } from './draft';
import { canvas, ColorRenderer, compose, context, cover, decode, digest, dimensions, encode, makeSegmenter, MatteDecoder, paintMask, readMatte, refinePhotoMask } from './graphics';
import { loadTemplateArt } from './templates';
import { Peer, type AssetKind, type Signal } from './peer';
import { LiveMaskFilter, type LiveMask } from './live-mask';
import { makeHandLandmarker, restoreHandMask } from './hand-mask';
import { appPath } from './paths';
import { api, linkId, mirrorKey, neutral, type Capture, type FilterKey, type Person, type RoomState, type Seat, type Session, type Slot } from './types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reason = (error: unknown) => error instanceof Error ? error.message : 'Terjadi kesalahan.';
const custom = (id: string) => /^[a-f0-9]{64}$/.test(id);
const makeVideo = () => Object.assign(document.createElement('video'), { autoplay: true, playsInline: true, muted: true });
type CaptureJob = Capture & { layers: Map<Seat, HTMLImageElement>; composing?: boolean };
type TransferInfo = { kind: AssetKind; id: string; digest: string };
type Remote = {
  peer: Peer; target: string; link: string; video: HTMLVideoElement; audio: HTMLAudioElement;
  matte?: MatteDecoder; time: number; frameAt: number; channel: boolean; connected: boolean; failed: boolean; relay: boolean; blocked: boolean;
  videoFrame?: number;
  presentedTime?: number;
};
type WorkerFrame = { type: 'frame'; bitmap: ImageBitmap; mask: LiveMask } |
  { type: 'portrait'; bitmap: ImageBitmap; alpha: VideoFrame };
type WorkerReply = WorkerFrame | { type: 'ready'; portrait: boolean } |
  { type: 'photo'; id: number; alpha?: ImageBitmap } | { type: 'error'; message: string };

function closeFrame(frame?: WorkerFrame) {
  frame?.bitmap.close();
  if (frame?.type === 'portrait') frame.alpha.close();
}

export type StudioEvents = {
  state: (state: RoomState) => void;
  status: (status: string) => void;
  notice: (message: string) => void;
  media: (camera: boolean, mic: boolean, audioBlocked: boolean) => void;
  activity: (message: string, countdown?: number) => void;
  photos: (photos: (Blob | undefined)[]) => void;
  captured: (slot: number) => void;
  connection: (connected: boolean) => void;
  templates: (ready: boolean) => void;
  closed: () => void;
};

export class Studio {
  private ws?: WebSocket;
  private peers = new Map<Seat, Remote>();
  private attempts = new Map<Seat, number>();
  private socketTimer?: number;
  private retry = 0;
  private stopped = false;
  private frame?: number;
  private lastPaint = -Infinity;
  private infer = 0;
  private inferPeriod = 1000 / 60;
  private sourceTime = -1;
  private videoFrame?: number;
  private presentedTime?: number;
  private worker?: Worker;
  private workerReady = false;
  private workerBusy = false;
  private completedFrame?: WorkerFrame;
  private portraitReady = false;
  private photoRequestId = 0;
  private photoRequest?: { id: number; finish: (alpha?: ImageBitmap) => void };
  private liveFilter = new LiveMaskFilter();
  private offset = 0;
  private cameraReady = false;
  private mediaStatus = '';
  private lastReady = '';
  private lastMedia = '';
  private job?: CaptureJob;
  private pendingExport?: { strip: Blob; finish: (success: boolean) => void };
  private captureId?: string;
  private countdown?: number;
  private state?: RoomState;
  private editing?: { seat: Seat; person: Person };
  private filters = { ...neutral };
  private mirror: boolean;
  private local = makeVideo();
  private videoTrack?: MediaStreamTrack;
  private audioTrack?: MediaStreamTrack;
  private live?: ImageSegmenter;
  private still?: Promise<ImageSegmenter>;
  private photoHands?: Promise<HandLandmarker | undefined>;
  private renderer?: ColorRenderer;
  private photoRenderer?: ColorRenderer;
  private packed = canvas(1152, 432);
  private outgoing?: MediaStreamTrack;
  private localMatte = new MatteDecoder(576);
  private inference = canvas();
  private mask = canvas();
  private assets = new Map<string, HTMLImageElement>();
  private draft: Draft;
  private requested = new Map<string, number>();
  private confirms = new Map<string, () => void>();
  private backgroundConfirmations = new Map<string, Promise<void>>();
  private acknowledged = new Map<string, () => void>();
  private backgroundBusy = false;
  private pendingBackgrounds = new Map<string, number>();
  private templateSelection?: { background: string; frame: string; ready: boolean };
  private templateRetry?: number;
  private storageWarned = false;

  constructor(private session: Session, private preview: HTMLCanvasElement, private events: StudioEvents) {
    this.draft = new Draft(session.roomId);
    this.mirror = sessionStorage.getItem(mirrorKey(session.roomId)) === '1';
    try {
      this.renderer = new ColorRenderer();
      this.outgoing = this.packed.captureStream?.(60).getVideoTracks()[0];
      if (!this.outgoing || typeof RTCPeerConnection === 'undefined') throw Error('Browser ini tidak mendukung pengiriman video photobooth.');
    } catch (error) {
      this.events.notice(reason(error));
    }
    this.openSocket();
    this.frame = requestAnimationFrame(this.render);
    void this.syncClock();
  }

  private async syncClock() {
    const before = Date.now();
    try {
      const { now } = await api<{ now: number }>('/time');
      this.offset = now - (before + Date.now()) / 2;
    } catch {}
  }

  private openSocket() {
    if (this.stopped) return;
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${appPath('ws')}`);
    ws.onopen = () => {
      this.lastReady = '';
      this.send({ type: 'auth', roomId: this.session.roomId, credential: this.session.credential });
      for (const [key, value] of Object.entries(this.filters)) this.send({ type: 'filter', key, value });
      this.send({ type: 'mirror', enabled: this.mirror });
      void this.syncClock();
    };
    ws.onmessage = ({ data }) => {
      if (this.stopped || this.ws !== ws) return;
      this.onMessage(JSON.parse(data));
    };
    ws.onclose = ({ code }) => {
      if (this.stopped || this.ws !== ws) return;
      for (const seat of this.peers.keys()) this.removePeer(seat);
      this.lastReady = '';
      this.clearCapture();
      this.events.connection(false);
      this.pendingExport?.finish(false);
      this.pendingExport = undefined;
      if (code === 4404) return this.roomClosed();
      if (code === 4409 || code === 4401) {
        this.events.status('Sesi terputus');
        this.events.notice(code === 4409 ? 'Room ini dibuka di tab lain.' : 'Sesi room tidak valid.');
        return;
      }
      this.events.status('Menyambungkan ulang…');
      this.socketTimer = window.setTimeout(() => this.openSocket(), Math.min(8000, 750 * 2 ** this.retry++));
    };
  }

  private send(message: object) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private removePeer(seat: Seat) {
    const remote = this.peers.get(seat);
    if (!remote) return;
    this.peers.delete(seat);
    remote.peer.close();
    if (remote.videoFrame !== undefined) remote.video.cancelVideoFrameCallback?.(remote.videoFrame);
    remote.video.srcObject = null;
    remote.audio.srcObject = null;
    this.updateMedia();
  }

  private link(state: RoomState) {
    const mine = state.presence[this.session.seat]?.id;
    for (const [seat, remote] of this.peers) {
      const target = state.presence[seat]?.id;
      if (mine && target && remote.link === linkId(state, mine, target)) continue;
      if (target !== remote.target) this.attempts.delete(seat);
      this.removePeer(seat);
    }
    if (!mine || !this.outgoing) return;
    const missing = Object.entries(state.presence).filter(([seat, peer]) => seat !== this.session.seat && peer.id && !this.peers.has(seat));
    if (missing.length) {
      const config = api<RTCConfiguration>(`/rooms/${this.session.roomId}/ice`, this.session.credential);
      for (const [seat, peer] of missing) this.connectPeer(seat, peer.id!, linkId(state, mine, peer.id!), config, this.outgoing);
    }
    const bitrate = Math.min(1_800_000, Math.round(4_500_000 / Math.max(1, this.peers.size)));
    for (const { peer } of this.peers.values()) peer.setBitrate(bitrate);
    this.updateStatus();
  }

  private connectPeer(seat: Seat, target: string, link: string, config: Promise<RTCConfiguration>, outgoing: MediaStreamTrack) {
    const video = makeVideo();
    const audio = new Audio();
    const peer = new Peer(config, outgoing, this.session.seat < seat, {
      signal: (signal) => this.send({ type: 'rtc:signal', target, link, ...signal }),
      track: (track) => {
        if (track.kind === 'video') {
          remote.time = -1;
          video.srcObject = new MediaStream([track]);
          if (video.requestVideoFrameCallback && remote.videoFrame === undefined) {
            const next: VideoFrameRequestCallback = (_, frame) => {
              remote.frameAt = performance.now();
              remote.presentedTime = frame.mediaTime;
              remote.videoFrame = video.requestVideoFrameCallback(next);
            };
            remote.videoFrame = video.requestVideoFrameCallback(next);
          }
          void video.play().catch(() => this.events.notice('Video peserta belum dapat diputar.'));
        } else {
          audio.srcObject = new MediaStream([track]);
          void this.playRemoteAudio(remote);
        }
      },
      status: (status) => {
        remote.connected = status === 'connected';
        remote.failed = status === 'failed';
        if (remote.connected) this.attempts.delete(seat);
        if (remote.failed) {
          const attempts = this.attempts.get(seat) ?? 0;
          if (attempts < 2) {
            this.attempts.set(seat, attempts + 1);
            this.send({ type: 'rtc:reset', target, link });
          }
        }
        this.updateStatus();
        this.reportMedia();
      },
      channel: (open) => {
        remote.channel = open;
        this.reportMedia();
        if (open) {
          void this.refreshDraft();
          const background = this.state?.layout.background;
          if (background && custom(background) && !this.assets.has(background)) this.requestAsset('background', background);
        }
      },
      event: ({ type, kind, id }) => {
        if (type === 'asset:ack') this.acknowledged.get(`${target}:${id}`)?.();
        if (type === 'asset:request' && (kind === 'photo' || kind === 'background')) {
          const allowed = this.state?.layout.background === id || this.state?.slots.some((slot) => slot?.id === id);
          if (allowed) void this.draft.get(id).then((blob) => {
            if (blob) return peer.send(kind, id, blob);
          }).catch((error) => this.events.notice(reason(error)));
        }
      },
      asset: (info, blob) => this.receiveAsset(seat, remote, info, blob),
      error: (error) => {
        this.events.notice(reason(error));
        const job = this.job;
        if (job?.members.includes(seat) && (job.compositor === seat || job.compositor === this.session.seat)) {
          this.send({ type: 'capture:failed', captureId: job.captureId });
        }
      },
      relay: (relayed) => { remote.relay = relayed; this.updateStatus(); },
    });
    const remote: Remote = { peer, target, link, video, audio, time: -1, frameAt: 0,
      connected: false, channel: false, failed: false, relay: false, blocked: false };
    this.peers.set(seat, remote);
    void peer.setAudio(this.audioTrack ?? null).catch((error) => this.events.notice(reason(error)));
  }

  private updateStatus() {
    const peers = [...this.peers.values()];
    const status = peers.some((peer) => peer.failed) ? 'Koneksi video gagal'
      : peers.some((peer) => !peer.connected) ? 'Menghubungkan video…'
      : peers.some((peer) => peer.relay) ? 'Terhubung melalui TURN'
      : peers.length ? 'Terhubung' : 'Siap untuk foto solo';
    this.events.status(status);
  }

  reconnect() {
    for (const [seat, remote] of this.peers) {
      if (!remote.failed) continue;
      this.attempts.delete(seat);
      this.send({ type: 'rtc:reset', target: remote.target, link: remote.link });
    }
  }

  private roomClosed() {
    this.draft.prune(new Set());
    this.events.closed();
  }

  private onMessage(event: { type: string } & Record<string, any>) {
    switch (event.type) {
      case 'state': {
        this.state = event as unknown as RoomState;
        this.retry = 0;
        this.events.connection(true);
        this.events.state(this.state);
        const { background, frame } = this.state.layout;
        if (this.templateSelection?.background !== background || this.templateSelection.frame !== frame) {
          const previous = this.templateSelection?.background;
          if (previous && previous !== background) this.assets.delete(previous);
          const selection = this.templateSelection = { background, frame, ready: false };
          this.events.templates(false);
          clearTimeout(this.templateRetry);
          void this.syncTemplates(selection);
        }
        this.link(this.state);
        this.reportMedia();
        void this.refreshDraft();
        if (!this.state.busy) this.clearCapture();
        break;
      }
      case 'rtc:signal': {
        const remote = [...this.peers.values()].find((peer) => peer.target === event.from && peer.link === event.link);
        remote?.peer.signal(event as Signal);
        break;
      }
      case 'capture:prepare':
        void this.prepare(event as unknown as Capture);
        break;
      case 'capture:start':
        if (this.captureId === event.captureId) this.countdownTo(event.captureId, event.targetTime);
        break;
      case 'capture:committed':
        this.clearCapture();
        this.events.captured(event.slot);
        this.events.notice(`Foto slot ${event.slot + 1} tersimpan.`);
        break;
      case 'capture:failed':
        this.draft.remove(event.captureId);
        this.clearCapture();
        this.events.notice(event.message);
        break;
      case 'slot:cleared':
        this.events.notice(`Foto slot ${event.slot + 1} dihapus.`);
        break;
      case 'export:started':
        void this.export(event.exportId, event.slots);
        break;
      case 'export:created':
        this.events.notice(`Versi ${event.version} tersimpan. Buka Album untuk mengunduh.`);
        break;
      case 'export:failed':
      case 'error':
        this.pendingExport?.finish(false);
        this.pendingExport = undefined;
        this.events.notice(event.message);
        break;
      case 'asset:ready':
        this.confirms.get(event.id)?.();
        break;
      case 'closed':
        this.roomClosed();
        break;
    }
  }

  private async refreshDraft() {
    const state = this.state;
    if (!state) return;
    const slots = await Promise.all(state.slots.map(async (slot, index) => {
      if (!slot) return;
      const blob = await this.draft.get(slot.id);
      if (!blob && this.state?.slots[index]?.id === slot.id) this.requestAsset('photo', slot.id);
      return blob;
    }));
    if (this.stopped || this.state !== state) return;
    this.events.photos(slots);
    const background = state.layout.background;
    if (!state.busy && !this.backgroundBusy && !this.job) {
      for (const [id, until] of this.pendingBackgrounds) {
        if (id === background || until <= Date.now()) {
          this.pendingBackgrounds.delete(id);
          if (id !== background) this.assets.delete(id);
        }
      }
      this.draft.prune(new Set([background, ...this.pendingBackgrounds.keys(), ...state.slots.flatMap((slot) => slot ? [slot.id] : [])]));
    }
  }

  private async syncTemplates(selection: NonNullable<Studio['templateSelection']>) {
    const { background, frame } = selection;
    const isCurrent = () => !this.stopped && this.templateSelection === selection;
    try {
      await loadTemplateArt(background, frame);
      if (!isCurrent()) return;
      if (custom(background) && !this.assets.has(background)) {
        const blob = await this.draft.get(background);
        if (!isCurrent()) return;
        if (blob) {
          const image = await decode(blob);
          if (!isCurrent()) return;
          this.assets.set(background, image);
        } else {
          this.requestAsset('background', background);
          this.templateRetry = window.setTimeout(() => void this.syncTemplates(selection), 5000);
          return;
        }
      }
      selection.ready = true;
      this.events.templates(true);
    } catch {
      if (isCurrent()) this.templateRetry = window.setTimeout(() => void this.syncTemplates(selection), 1800);
    }
  }

  private requestAsset(kind: AssetKind, id: string) {
    for (const remote of this.peers.values()) {
      if (!remote.channel) continue;
      const key = `${remote.link}:${id}`;
      if ((this.requested.get(key) ?? 0) > Date.now()) continue;
      this.requested.set(key, Date.now() + 5000);
      remote.peer.control({ type: 'asset:request', kind, id });
    }
    for (const [key, until] of this.requested) if (until <= Date.now()) this.requested.delete(key);
  }

  private updateMedia() {
    const camera = this.videoTrack?.enabled === true;
    const mic = this.audioTrack?.enabled === true;
    const blocked = [...this.peers.values()].some((peer) => peer.blocked);
    const next = `${camera}:${mic}:${blocked}`;
    if (next === this.lastMedia) return;
    this.lastMedia = next;
    this.events.media(camera, mic, blocked);
  }

  async playAudio() {
    await Promise.all([...this.peers.values()].map((remote) => this.playRemoteAudio(remote)));
  }

  private async playRemoteAudio(remote: Remote) {
    try {
      if (remote.audio.srcObject) await remote.audio.play();
      remote.blocked = false;
    } catch {
      remote.blocked = true;
    }
    this.updateMedia();
  }

  async toggleMedia(kind: 'video' | 'audio') {
    const track = kind === 'video' ? this.videoTrack : this.audioTrack;
    if (track && track.readyState === 'live') {
      if (kind === 'video') {
        track.stop();
        this.videoTrack = undefined;
        this.cameraReady = false;
        this.stopLiveMask();
        this.local.srcObject = null;
        const ctx = context(this.packed);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, this.packed.width, this.packed.height);
      } else track.enabled = !track.enabled;
      this.updateMedia();
      this.reportMedia();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.events.notice('Kamera dan mikrofon memerlukan HTTPS atau localhost.');
      return;
    }
    try {
      if (kind === 'video' && (!this.renderer || !this.outgoing)) throw Error('Browser ini tidak mendukung pipeline kamera photobooth.');
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'video'
        ? { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } } }
        : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const media = stream.getTracks()[0];
      if (this.stopped) return media.stop();
      if (kind === 'video') {
        this.videoTrack = media;
        this.local.srcObject = stream;
        this.sourceTime = -1;
        this.infer = 0;
        this.cameraReady = false;
        if (this.local.requestVideoFrameCallback) {
          const next: VideoFrameRequestCallback = (_, frame) => {
            this.presentedTime = frame.mediaTime;
            this.videoFrame = this.local.requestVideoFrameCallback(next);
            this.queueLiveFrame(performance.now());
          };
          this.videoFrame = this.local.requestVideoFrameCallback(next);
        }
        await this.local.play();
        await this.startLiveMask(media);
      } else {
        this.audioTrack = media;
        await Promise.all([...this.peers.values()].map(({ peer }) => peer.setAudio(media)));
        void this.playAudio();
      }
      media.onended = () => {
        if (kind === 'video') {
          this.videoTrack = undefined;
          this.cameraReady = false;
          this.stopLiveMask();
        } else this.audioTrack = undefined;
        this.updateMedia();
        this.reportMedia();
        this.events.notice(kind === 'video' ? 'Kamera terputus.' : 'Mikrofon terputus.');
      };
    } catch (error) {
      if (kind === 'video') {
        this.videoTrack?.stop();
        this.videoTrack = undefined;
        this.cameraReady = false;
        this.stopLiveMask();
        this.local.srcObject = null;
      } else {
        this.audioTrack?.stop();
        this.audioTrack = undefined;
      }
      const label = kind === 'video' ? 'Kamera atau pemisahan latar' : 'Mikrofon';
      this.events.notice(`${label} gagal diaktifkan. ${reason(error)}`);
    }
    this.updateMedia();
    this.reportMedia();
  }

  private reportMedia() {
    const links = [...this.peers.values()].filter((peer) => peer.connected && peer.channel).map((peer) => peer.link).sort();
    const status = `${this.cameraReady}:${links.join(',')}`;
    if (status === this.lastReady || !this.state?.presence[this.session.seat]?.online) return;
    if (this.send({ type: 'media', camera: this.cameraReady, links })) this.lastReady = status;
  }

  private async startLiveMask(track: MediaStreamTrack) {
    this.events.notice('Menyiapkan pemisahan latar…');
    if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function') {
      try {
        const worker = this.worker = new Worker(new URL('./live-mask.worker.ts', import.meta.url), { type: 'module' });
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(Error('Worker segmentasi tidak merespons.')), 8000);
          const fail = (error: Error) => {
            clearTimeout(timeout);
            if (!this.workerReady) reject(error);
            else if (this.worker === worker && this.videoTrack === track) void this.fallbackLiveMask(track);
          };
          worker.onerror = () => fail(Error('Worker segmentasi gagal berjalan.'));
          worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
            if (this.worker !== worker) {
              if (data.type === 'frame' || data.type === 'portrait') closeFrame(data);
              if (data.type === 'photo') data.alpha?.close();
              return;
            }
            if (data.type === 'ready') {
              clearTimeout(timeout);
              this.portraitReady = data.portrait;
              this.workerReady = true;
              resolve();
            } else if (data.type === 'error') {
              fail(Error(data.message));
            } else if (data.type === 'photo') {
              if (this.photoRequest?.id === data.id) this.photoRequest.finish(data.alpha);
              else data.alpha?.close();
            } else {
              this.workerBusy = false;
              closeFrame(this.completedFrame);
              this.completedFrame = data;
              this.queueLiveFrame(performance.now());
            }
          };
        });
        return;
      } catch {
        if (this.stopped || this.videoTrack !== track) return;
      }
    }
    await this.fallbackLiveMask(track);
  }

  private async fallbackLiveMask(track: MediaStreamTrack) {
    this.worker?.terminate();
    this.worker = undefined;
    this.workerReady = this.workerBusy = this.portraitReady = false;
    this.photoRequest?.finish();
    closeFrame(this.completedFrame);
    this.completedFrame = undefined;
    try {
      const live = await makeSegmenter('VIDEO');
      if (this.stopped || this.videoTrack !== track) return live.close();
      this.live = live;
      this.inferPeriod = 1000 / 30;
    } catch (error) {
      if (this.videoTrack !== track) return;
      track.stop();
      this.videoTrack = undefined;
      this.cameraReady = false;
      this.local.srcObject = null;
      this.stopLiveMask();
      this.updateMedia();
      this.reportMedia();
      this.events.notice(`Pemisahan latar gagal. ${reason(error)}`);
    }
  }

  private stopLiveMask() {
    if (this.videoFrame !== undefined) this.local.cancelVideoFrameCallback?.(this.videoFrame);
    this.videoFrame = this.presentedTime = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.workerReady = this.workerBusy = this.portraitReady = false;
    this.photoRequest?.finish();
    closeFrame(this.completedFrame);
    this.completedFrame = undefined;
    this.live?.close();
    this.live = undefined;
    this.liveFilter = new LiveMaskFilter();
  }

  private queueLiveFrame(time: number) {
    const worker = this.worker;
    const source = this.local;
    const sourceTime = this.presentedTime ?? source.currentTime;
    if (!worker || !this.workerReady || this.workerBusy || !this.videoTrack?.enabled ||
        source.readyState < 2 || !source.videoWidth || sourceTime === this.sourceTime) return;
    this.sourceTime = sourceTime;
    this.workerBusy = true;
    const factor = 576 / Math.max(source.videoWidth, source.videoHeight);
    const width = Math.max(2, Math.round(source.videoWidth * factor / 2) * 2);
    const height = Math.max(2, Math.round(source.videoHeight * factor / 2) * 2);
    void createImageBitmap(source, { resizeWidth: width, resizeHeight: height }).then((bitmap) => {
      if (this.worker !== worker) return bitmap.close();
      try {
        worker.postMessage({ bitmap, time }, [bitmap]);
      } catch (error) {
        bitmap.close();
        throw error;
      }
    }).catch(() => {
      const track = this.videoTrack;
      if (track && this.worker === worker) void this.fallbackLiveMask(track);
    });
  }

  private drawLocal(source: HTMLVideoElement | ImageBitmap, w: number, h: number, matte: LiveMask | VideoFrame) {
    let mask: HTMLCanvasElement | VideoFrame;
    if ('pixels' in matte) {
      paintMask(this.mask, matte);
      mask = this.mask;
    } else {
      mask = matte;
    }
    if (this.packed.width !== w * 2) this.packed.width = w * 2;
    if (this.packed.height !== h) this.packed.height = h;
    this.renderer!.draw(source, w, h, this.filters, mask);
    const ctx = context(this.packed);
    ctx.save();
    if (this.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.renderer!.output, 0, 0, w, h);
    ctx.drawImage(mask, this.mirror ? -w : w, 0, w, h);
    ctx.restore();
    this.localMatte.draw(this.packed, w * 2, h);
    if (!this.cameraReady) {
      this.cameraReady = true;
      this.events.notice('');
      this.reportMedia();
    }
  }

  private render = (time: number) => {
    if (this.stopped) return;
    this.frame = requestAnimationFrame(this.render);
    const interval = 1000 / 60;
    if (time - this.lastPaint < interval - 0.8) return;
    this.lastPaint = time - this.lastPaint > interval * 2 ? time : this.lastPaint + interval;
    try {
      const completed = this.completedFrame;
      if (completed) {
        this.completedFrame = undefined;
        try {
          this.drawLocal(completed.bitmap, completed.bitmap.width, completed.bitmap.height,
            completed.type === 'portrait' ? completed.alpha : completed.mask);
        } finally {
          closeFrame(completed);
        }
      }
      if (this.videoFrame === undefined) this.queueLiveFrame(time);
      if (this.live && this.videoTrack?.enabled && this.local.readyState >= 2 && this.local.videoWidth) {
        const source = this.local;
        const sourceTime = this.presentedTime ?? source.currentTime;
        if (sourceTime !== this.sourceTime && time - this.infer >= this.inferPeriod - 0.5) {
          this.sourceTime = sourceTime;
          this.infer = time;
          const factor = 576 / Math.max(source.videoWidth, source.videoHeight);
          const w = Math.max(2, Math.round(source.videoWidth * factor / 2) * 2);
          const h = Math.max(2, Math.round(source.videoHeight * factor / 2) * 2);
          const inferenceScale = 256 / Math.max(w, h);
          const width = Math.max(1, Math.round(w * inferenceScale)), height = Math.max(1, Math.round(h * inferenceScale));
          if (this.inference.width !== width) this.inference.width = width;
          if (this.inference.height !== height) this.inference.height = height;
          const ctx = context(this.inference, true);
          ctx.drawImage(source, 0, 0, width, height);
          const sample = ctx.getImageData(0, 0, width, height);
          const began = performance.now();
          this.live.segmentForVideo(this.inference, time, (result) => this.drawLocal(source, w, h, this.liveFilter.apply(result, sample, time)));
          this.inferPeriod = Math.max(1000 / 30, (performance.now() - began) * 2);
        }
      }
      if (!this.state) return;
      const layout = this.state.layout;
      const [w, h] = dimensions(layout.ratio, 780);
      if (this.preview.width !== w) this.preview.width = w;
      if (this.preview.height !== h) this.preview.height = h;
      const layers = new Map<Seat, HTMLCanvasElement>();
      if (this.cameraReady) layers.set(this.session.seat, this.localMatte.output);
      for (const [seat, remote] of this.peers) {
        const video = remote.video;
        if (!remote.connected || !this.state.presence[seat]?.camera) continue;
        const mediaTime = remote.presentedTime ?? video.currentTime;
        if (video.readyState >= 2 && video.videoWidth && mediaTime !== remote.time) {
          remote.time = mediaTime;
          remote.frameAt = time;
          remote.matte ??= new MatteDecoder();
          remote.matte.draw(video, video.videoWidth, video.videoHeight);
        }
        if (remote.matte && time - remote.frameAt < 3000) layers.set(seat, remote.matte.output);
      }
      if (this.templateSelection?.ready) compose(this.preview, layout, layers, this.assets.get(layout.background), this.editing);
    } catch (error) {
      if (this.mediaStatus !== reason(error)) this.events.notice(reason(error));
      this.mediaStatus = reason(error);
      this.cameraReady = false;
      this.reportMedia();
    }
  };

  setFilter(key: FilterKey, value: number) {
    this.filters[key] = value;
    this.send({ type: 'filter', key, value });
  }

  setMirror(enabled: boolean) {
    this.mirror = enabled;
    sessionStorage.setItem(mirrorKey(this.session.roomId), enabled ? '1' : '0');
    this.send({ type: 'mirror', enabled });
  }

  change(key: string, value: unknown, options: object = {}) {
    if (!this.send({ type: 'layout', key, value, ...options })) this.events.notice('Tunggu hingga room tersambung kembali.');
  }

  previewLayer(seat: Seat, person?: Person) {
    this.editing = person ? { seat, person } : undefined;
  }

  capture(slot: number) {
    if (!this.send({ type: 'capture:request', slot })) this.events.notice('Tunggu hingga room tersambung kembali.');
  }

  clearSlot(slot: number, id: string) {
    if (!this.send({ type: 'slot:clear', slot, id })) this.events.notice('Tunggu hingga room tersambung kembali.');
  }

  async getStripPhotos(slots: string[]) {
    const photos = await Promise.all(slots.map((id) => this.draft.get(id)));
    if (!photos.every((photo): photo is Blob => Boolean(photo))) throw Error('Tunggu semua foto tersinkron sebelum mengekspor.');
    return photos;
  }

  requestExport(strip: Blob, slots: string[], layout: Pick<Capture['layout'], 'strip' | 'ratio' | 'frame'>) {
    if (this.pendingExport) return Promise.resolve(false);
    if (!this.send({ type: 'export:request', slots, strip: layout.strip, ratio: layout.ratio, frame: layout.frame })) {
      this.events.notice('Tunggu hingga room tersambung kembali.');
      return Promise.resolve(false);
    }
    return new Promise<boolean>((finish) => { this.pendingExport = { strip, finish }; });
  }

  private async saveDraft(id: string, blob: Blob) {
    try {
      await this.draft.put(id, blob);
    } catch {
      if (!this.storageWarned) this.events.notice('Penyimpanan browser tidak tersedia. Draft ini hanya bertahan selama tab terbuka.');
      this.storageWarned = true;
    }
  }

  private async prepare(capture: Capture) {
    this.captureId = capture.captureId;
    this.events.activity('Menyiapkan kamera peserta…');
    if (!capture.members.includes(this.session.seat)) return;
    this.job = { ...capture, layers: new Map() };
    try {
      const targets = capture.compositor === this.session.seat
        ? capture.members.filter((seat) => seat !== this.session.seat)
        : [capture.compositor];
      if (!this.cameraReady || targets.some((seat) => !this.peers.get(seat)?.channel) ||
          (capture.compositor === this.session.seat && custom(capture.layout.background) && !this.assets.has(capture.layout.background))) {
        throw Error('Kamera, koneksi, atau latar belum siap.');
      }
      await Promise.all([this.portraitReady ? undefined : this.prepareFallbackPhoto(), this.syncClock(),
        capture.compositor === this.session.seat ? loadTemplateArt(capture.layout.background, capture.layout.frame, true) : undefined]);
      if (this.job?.captureId === capture.captureId) this.send({ type: 'capture:ready', captureId: capture.captureId });
    } catch (error) {
      this.events.notice(reason(error));
      this.send({ type: 'capture:failed', captureId: capture.captureId });
    }
  }

  private countdownTo(id: string, target: number) {
    const job = this.job;
    const step = () => {
      if (this.captureId !== id) return;
      const left = target - this.offset - Date.now();
      if (left > 0) {
        this.events.activity('Bersiap untuk foto', Math.min(3, Math.ceil(left / 1000)));
        this.countdown = window.setTimeout(step, Math.min(left, 100));
      } else {
        this.events.activity('Mengambil foto…');
        if (job) void this.take(job).catch((error) => {
          this.events.notice(reason(error));
          this.send({ type: 'capture:failed', captureId: job.captureId });
        });
      }
    };
    step();
  }

  private async take(job: CaptureJob) {
    if (!this.cameraReady || !this.videoTrack) throw Error('Kamera belum siap.');
    const track = this.videoTrack;
    let source: HTMLImageElement | HTMLCanvasElement;
    const snapshot = canvas(this.local.videoWidth, this.local.videoHeight);
    context(snapshot).drawImage(this.local, 0, 0);
    source = snapshot;
    const ImageCapture = (window as unknown as { ImageCapture?: new (track: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
    if (ImageCapture) {
      try {
        const photo = await Promise.race([
          new ImageCapture(track).takePhoto(),
          wait(1800).then(() => { throw Error('Mode foto tidak merespons.'); }),
        ]);
        source = await decode(photo);
      } catch {
        this.events.notice('Mode foto kamera gagal. Menggunakan frame kamera lokal.');
      }
    }
    if (this.job !== job || track.readyState !== 'live') return;
    const previewRatio = snapshot.width / snapshot.height;
    const sourceWidth = Math.min(source.width, source.height * previewRatio);
    const sourceHeight = Math.min(source.height, source.width / previewRatio);
    const factor = Math.min(1, 2560 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * factor)), height = Math.max(1, Math.round(sourceHeight * factor));
    if (source instanceof HTMLImageElement) {
      const matchingCrop = canvas(width, height);
      cover(context(matchingCrop), source, 0, 0, width, height);
      source = matchingCrop;
    }
    this.photoRenderer ??= new ColorRenderer();
    const mask = canvas();
    const portrait = await this.takePortraitMask(source);
    if (portrait) {
      mask.width = portrait.width;
      mask.height = portrait.height;
      context(mask, true).drawImage(portrait, 0, 0);
      portrait.close();
    }
    if (this.job !== job) return;
    if (!portrait) await this.takeFallbackMask(source, mask, width, height, job);
    if (this.job !== job) return;
    this.photoRenderer.draw(source, width, height, job.filters[this.session.seat], portrait ? mask : undefined);
    const refined = portrait ? undefined : refinePhotoMask(this.photoRenderer.output, mask);
    if (portrait) {
      const maskContext = context(mask, true);
      maskContext.putImageData(readMatte(maskContext), 0, 0);
    }
    const output = canvas(width, height);
    const ctx = context(output);
    if (job.mirrors[this.session.seat]) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.photoRenderer.output, 0, 0);
    if (refined) ctx.drawImage(refined.spill, 0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(refined?.alpha ?? mask, 0, 0, width, height);
    const blob = await encode(output, 'image/png');
    if (this.job !== job) return;
    this.events.activity('Menyusun dan menyinkronkan foto…');
    if (job.compositor === this.session.seat) {
      job.layers.set(this.session.seat, await decode(blob));
      await this.finishCapture(job);
    } else {
      const remote = this.peers.get(job.compositor);
      if (!remote) throw Error('Koneksi pengambil foto terputus.');
      await remote.peer.send('foreground', job.captureId, blob);
    }
  }

  private async takePortraitMask(source: HTMLCanvasElement | HTMLImageElement) {
    const worker = this.worker;
    if (!this.portraitReady || !worker) return;
    const scale = Math.min(1, 768 / Math.max(source.width, source.height));
    const bitmap = await createImageBitmap(source, {
      resizeWidth: Math.max(1, Math.round(source.width * scale)),
      resizeHeight: Math.max(1, Math.round(source.height * scale)),
    }).catch(() => undefined);
    if (!bitmap) return;
    if (this.worker !== worker) return bitmap.close();
    this.photoRequest?.finish();
    return new Promise<ImageBitmap | undefined>((resolve) => {
      const id = ++this.photoRequestId;
      const finish = (alpha?: ImageBitmap) => {
        clearTimeout(timeout);
        this.photoRequest = undefined;
        resolve(alpha);
      };
      const timeout = window.setTimeout(finish, 1800);
      this.photoRequest = { id, finish };
      try {
        worker.postMessage({ bitmap, photo: id }, [bitmap]);
      } catch {
        bitmap.close();
        finish();
      }
    });
  }

  private async takeFallbackMask(source: HTMLCanvasElement | HTMLImageElement, mask: HTMLCanvasElement,
    width: number, height: number, job: CaptureJob) {
    const segmenter = await this.prepareFallbackPhoto();
    if (this.job !== job) return;
    const maskScale = Math.min(1, 384 / Math.max(width, height));
    const input = canvas(Math.max(1, Math.round(width * maskScale)), Math.max(1, Math.round(height * maskScale)));
    const inputContext = context(input);
    inputContext.drawImage(source, 0, 0, input.width, input.height);
    const sample = inputContext.getImageData(0, 0, input.width, input.height);
    const filter = new LiveMaskFilter();
    let landmarks;
    try {
      landmarks = (await this.photoHands)?.detect(source).landmarks;
    } catch {
      // The body mask is still available when hand tracking fails.
    }
    if (this.job !== job) return;
    segmenter.segment(input, (result) => {
      const matte = filter.apply(result, sample, 0, false);
      if (landmarks?.length) restoreHandMask(matte, sample, landmarks);
      paintMask(mask, matte);
    });
  }

  private prepareFallbackPhoto() {
    this.photoHands ??= makeHandLandmarker('IMAGE').catch(() => undefined);
    return this.still ??= makeSegmenter('IMAGE').catch((error) => {
      this.still = undefined;
      throw error;
    });
  }

  private async finishCapture(job: CaptureJob) {
    if (this.job !== job || job.members.some((seat) => !job.layers.has(seat)) || job.composing) return;
    job.composing = true;
    const edge = Math.max(...[...job.layers.values()].map((image) => Math.max(image.naturalWidth, image.naturalHeight)));
    const output = canvas(...dimensions(job.layout.ratio, Math.min(2560, Math.max(960, edge))));
    compose(output, job.layout, job.layers, this.assets.get(job.layout.background), undefined, true);
    const blob = await encode(output, 'image/jpeg', 0.95);
    if (this.job !== job) return;
    await this.saveDraft(job.captureId, blob);
    await Promise.all(job.members.filter((seat) => seat !== this.session.seat).map((seat) => {
      const remote = this.peers.get(seat);
      if (!remote) throw Error('Koneksi peserta terputus.');
      return remote.peer.send('photo', job.captureId, blob);
    }));
    if (this.job === job) this.send({ type: 'capture:stored', captureId: job.captureId, digest: await digest(blob) });
  }

  private clearCapture() {
    if (this.job && !this.state?.slots.some((slot) => slot?.id === this.job?.captureId) && !this.state?.busy) {
      this.draft.remove(this.job.captureId);
    }
    this.job = undefined;
    this.captureId = undefined;
    clearTimeout(this.countdown);
    this.events.activity('');
  }

  private async receiveAsset(seat: Seat, remote: Remote, info: TransferInfo, blob: Blob) {
    if (this.stopped || this.peers.get(seat) !== remote) return;
    const job = this.job;
    if (info.kind === 'foreground' && job?.captureId === info.id && job.compositor === this.session.seat &&
        job.members.includes(seat) && !job.layers.has(seat)) {
      const image = await decode(blob);
      if (this.job !== job || this.peers.get(seat) !== remote) return;
      job.layers.set(seat, image);
      return this.finishCapture(job);
    }
    if (info.kind === 'photo') {
      const fromCompositor = job?.captureId === info.id && job.compositor === seat;
      const isCurrentSlot = () => this.state?.slots.some((slot) => slot?.id === info.id && slot.digest === info.digest);
      if (!fromCompositor && !isCurrentSlot()) return;
      if (!fromCompositor && this.draft.blobs.has(info.id)) return;
      await decode(blob);
      if (fromCompositor ? this.job !== job : !isCurrentSlot()) return;
      await this.saveDraft(info.id, blob);
      if (fromCompositor && job && this.job === job) {
        this.send({ type: 'capture:stored', captureId: info.id, digest: info.digest });
      } else void this.refreshDraft();
    }
    if (info.kind === 'background' && info.id === info.digest) {
      const image = await decode(blob);
      if (image.naturalWidth > 1920 || image.naturalHeight > 1920) throw Error('Dimensi latar melampaui batas.');
      this.assets.set(info.id, image);
      this.pendingBackgrounds.set(info.id, Date.now() + 60_000);
      await this.saveDraft(info.id, blob);
      await this.confirmBackground(info.id);
      remote.peer.control({ type: 'asset:ack', kind: 'background', id: info.id });
      if (this.templateSelection?.background === info.id && !this.templateSelection.ready) {
        clearTimeout(this.templateRetry);
        void this.syncTemplates(this.templateSelection);
      }
    }
  }

  private async confirmBackground(id: string) {
    if (this.backgroundConfirmations.has(id)) return this.backgroundConfirmations.get(id);
    const confirmation = this.waitFor(this.confirms, id, () => this.send({ type: 'asset:ready', id }), 3500)
      .finally(() => this.backgroundConfirmations.delete(id));
    this.backgroundConfirmations.set(id, confirmation);
    return confirmation;
  }

  private async waitFor(map: Map<string, () => void>, id: string, send: () => unknown, timeout: number) {
    let timer = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = window.setTimeout(() => reject(Error('Konfirmasi transfer latar tidak diterima.')), timeout);
        map.set(id, resolve);
        Promise.resolve().then(send).catch(reject);
      });
    } finally {
      clearTimeout(timer);
      map.delete(id);
    }
  }

  async uploadBackground(file: File) {
    if (this.backgroundBusy) return;
    this.backgroundBusy = true;
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 15 * 1024 ** 2) {
        throw Error('Pilih gambar JPEG, PNG, atau WebP hingga 15 MB.');
      }
      const image = await decode(file);
      const factor = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
      const surface = canvas(Math.round(image.naturalWidth * factor), Math.round(image.naturalHeight * factor));
      const ctx = context(surface);
      ctx.fillStyle = '#faf4ea';
      ctx.fillRect(0, 0, surface.width, surface.height);
      ctx.drawImage(image, 0, 0, surface.width, surface.height);
      const blob = await encode(surface, 'image/jpeg', 0.91);
      const id = await digest(blob);
      this.assets.set(id, await decode(blob));
      await this.saveDraft(id, blob);
      await this.confirmBackground(id);
      const targets = Object.entries(this.state?.presence ?? {}).filter(([seat, presence]) => seat !== this.session.seat && presence.online);
      await Promise.all(targets.map(([seat]) => {
        const remote = this.peers.get(seat);
        if (!remote?.channel) throw Error('Tunggu koneksi peserta siap untuk membagikan latar.');
        return this.waitFor(this.acknowledged, `${remote.target}:${id}`, () => remote.peer.send('background', id, blob), 45_000);
      }));
      if (!this.send({ type: 'asset:select', id })) throw Error('Room terputus saat mengatur latar.');
    } catch (error) {
      this.events.notice(reason(error));
    } finally {
      this.backgroundBusy = false;
    }
  }

  private async export(id: string, slots: Slot[]) {
    const base = `/rooms/${this.session.roomId}/exports/${id}`;
    const pending = this.pendingExport;
    this.pendingExport = undefined;
    try {
      if (!pending) throw Error('Pratinjau photostrip belum siap.');
      this.events.activity('Menyiapkan photostrip…');
      const photos = await this.getStripPhotos(slots.map((slot) => slot.id));
      const files = [pending.strip, ...photos];
      for (const [position, file] of files.entries()) {
        this.events.activity(`Menyimpan berkas ${position + 1} dari ${files.length}…`);
        await api(`${base}/${position}`, this.session.credential, {
          method: 'PUT', body: file, headers: { 'Content-Type': 'image/jpeg' }, signal: AbortSignal.timeout(60_000),
        });
      }
      const commit = () => api(`${base}/commit`, this.session.credential, { method: 'POST', signal: AbortSignal.timeout(15_000) });
      try {
        await commit();
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
        await commit();
      }
      pending.finish(true);
    } catch (error) {
      pending?.finish(false);
      this.send({ type: 'export:cancel', exportId: id });
      this.events.notice(reason(error));
    }
  }

  async leave() {
    await api(`/rooms/${this.session.roomId}/leave`, this.session.credential, { method: 'POST' });
  }

  close() {
    this.stopped = true;
    this.pendingExport?.finish(false);
    this.pendingExport = undefined;
    clearTimeout(this.socketTimer);
    clearTimeout(this.templateRetry);
    clearTimeout(this.countdown);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.ws?.close();
    for (const seat of this.peers.keys()) this.removePeer(seat);
    this.videoTrack?.stop();
    this.audioTrack?.stop();
    this.outgoing?.stop();
    this.renderer?.close();
    this.photoRenderer?.close();
    this.stopLiveMask();
    void this.still?.then((value) => value.close()).catch(() => {});
    void this.photoHands?.then((value) => value?.close());
    this.draft.close();
  }
}
