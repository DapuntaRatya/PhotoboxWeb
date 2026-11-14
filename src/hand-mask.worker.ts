import { makeHandLandmarker } from './hand-mask';

const detector = makeHandLandmarker('VIDEO', new OffscreenCanvas(1, 1));
detector.catch(() => self.postMessage({ type: 'unavailable' }));

self.onmessage = async ({ data }: MessageEvent<{ bitmap: ImageBitmap; time: number }>) => {
  try {
    const task = await detector;
    const { landmarks } = task.detectForVideo(data.bitmap, data.time);
    self.postMessage({ type: 'hands', landmarks });
  } catch {
    self.postMessage({ type: 'unavailable' });
  } finally {
    data.bitmap.close();
  }
};
