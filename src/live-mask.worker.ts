import { FilesetResolver, ImageSegmenter, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import { LiveMaskFilter } from './live-mask';
import { restoreHandMask } from './hand-mask';
import type { BackgroundRemover } from '@katana-video/web-bg-removal';

const filter = new LiveMaskFilter();
const input = new OffscreenCanvas(1, 1);
const inputContext = input.getContext('2d', { willReadFrequently: true })!;
let portrait: BackgroundRemover | undefined;
let segmenter: Promise<ImageSegmenter> | undefined;
let lastPortraitFrame = -Infinity;
const initializeFallback = () => FilesetResolver.forVisionTasks(new URL('/vision', location.origin).href, true)
  .then((files) => ImageSegmenter.createFromOptions(files, {
    canvas: new OffscreenCanvas(1, 1),
    baseOptions: { modelAssetPath: new URL('/vision/person.tflite', location.origin).href, delegate: 'CPU' },
    runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
  }));

let handWorker: Worker | undefined;
let pending: { sample: ImageData; time: number } | undefined;
let tracked: { sample: ImageData; time: number; landmarks: NormalizedLandmark[][] } | undefined;
let lastHandFrame = -Infinity;

function stopHandWorker() {
  handWorker?.terminate();
  handWorker = pending = tracked = undefined;
}

function startFallback() {
  try {
    handWorker = new Worker(new URL('./hand-mask.worker.ts', import.meta.url), { type: 'module' });
    handWorker.onerror = stopHandWorker;
    handWorker.onmessage = ({ data }: MessageEvent<{ type: 'hands'; landmarks: NormalizedLandmark[][] } | { type: 'unavailable' }>) => {
      if (data.type === 'unavailable') return stopHandWorker();
      if (pending) tracked = { ...pending, landmarks: data.landmarks };
      pending = undefined;
    };
  } catch {
    stopHandWorker();
  }
  return segmenter ??= initializeFallback();
}

async function initialize() {
  try {
    const gpu = (navigator as Navigator & { gpu?: {
      requestAdapter(): Promise<{ info: { isFallbackAdapter: boolean }; features: ReadonlySet<string> } | null>;
    } }).gpu;
    const adapter = await gpu?.requestAdapter();
    if (typeof VideoFrame !== 'undefined' && adapter && !adapter.info.isFallbackAdapter && adapter.features.has('shader-f16')) {
      const { BackgroundRemover } = await import('@katana-video/web-bg-removal');
      portrait = await BackgroundRemover.load('longpipe-large', {
        backend: 'webgpu', dtype: 'f16', weightsBaseUrl: new URL('/vision/', location.origin).href,
      });
    }
  } catch {
    // Keep the CPU path available when the browser or GPU cannot run the portrait model.
  }
  if (!portrait) await startFallback();
  self.postMessage({ type: 'ready', portrait: Boolean(portrait) });
}

void initialize().catch(reportError);

type Request = { bitmap: ImageBitmap; time: number } | { bitmap: ImageBitmap; photo: number };
let frames = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<Request>) => {
  frames = frames.then(() => processFrame(data)).catch(reportError);
};

async function processFrame(data: Request) {
  const { bitmap } = data;
  try {
    if ('photo' in data) {
      let alpha: ImageBitmap | undefined;
      try {
        alpha = await portrait?.removeBackground(bitmap, { output: 'alpha' });
        self.postMessage({ type: 'photo', id: data.photo, alpha }, { transfer: alpha ? [alpha] : [] });
      } catch {
        alpha?.close();
        self.postMessage({ type: 'photo', id: data.photo });
      }
      return;
    }
    const { time } = data;
    if (portrait) {
      const frame = new VideoFrame(bitmap, { timestamp: Math.round(time * 1000) });
      let alpha: VideoFrame | undefined;
      try {
        if (time - lastPortraitFrame > 180) portrait.reset();
        lastPortraitFrame = time;
        alpha = await portrait.process(frame, { output: 'alpha' });
        self.postMessage({ type: 'portrait', bitmap, alpha }, { transfer: [bitmap, alpha] });
        return;
      } catch {
        alpha?.close();
        portrait.destroy();
        portrait = undefined;
        self.postMessage({ type: 'ready', portrait: false });
      } finally {
        frame.close();
      }
    }
    const task = await (segmenter ?? startFallback());
    const scale = 256 / Math.max(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    if (input.width !== width) input.width = width;
    if (input.height !== height) input.height = height;
    inputContext.drawImage(bitmap, 0, 0, width, height);
    const sample = inputContext.getImageData(0, 0, width, height);
    if (handWorker && !pending && time - lastHandFrame >= 80) {
      const worker = handWorker;
      pending = { sample, time };
      lastHandFrame = time;
      void createImageBitmap(bitmap).then((copy) => {
        if (handWorker !== worker) return copy.close();
        try {
          worker.postMessage({ bitmap: copy, time }, [copy]);
        } catch {
          copy.close();
          stopHandWorker();
        }
      }).catch(stopHandWorker);
    }
    task.segmentForVideo(input, time, (result) => {
      const mask = filter.apply(result, sample, time);
      if (tracked?.landmarks.length && time - tracked.time <= 180) {
        restoreHandMask(mask, sample, tracked.landmarks, tracked.sample);
      }
      self.postMessage({ type: 'frame', bitmap, mask }, { transfer: [bitmap, mask.pixels.buffer] });
    });
  } catch (error) {
    reportError(error);
  } finally {
    bitmap.close();
  }
}

function reportError(error: unknown) {
  self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Segmentasi video gagal.' });
}
