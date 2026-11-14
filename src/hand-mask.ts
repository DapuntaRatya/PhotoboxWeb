import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { LiveMask } from './live-mask';

export async function makeHandLandmarker(runningMode: 'VIDEO' | 'IMAGE', canvas?: OffscreenCanvas) {
  const files = await FilesetResolver.forVisionTasks(new URL('/vision', location.origin).href, Boolean(canvas));
  return HandLandmarker.createFromOptions(files, {
    canvas,
    baseOptions: { modelAssetPath: '/vision/hand-landmarker.task', delegate: 'CPU' },
    runningMode, numHands: 2, minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6,
  });
}

// Each finger is refined separately so the space between fingers stays transparent.
const fingers = [
  [2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20],
];
const palmOutline = [0, 1, 2, 5, 9, 13, 17];

export function restoreHandMask(mask: LiveMask, sample: ImageData, hands: NormalizedLandmark[][], reference = sample) {
  const { width, height, pixels } = mask;
  const sampleIndex = (x: number, y: number) => {
    const sx = Math.max(0, Math.min(sample.width - 1, Math.floor(x * sample.width / width)));
    const sy = Math.max(0, Math.min(sample.height - 1, Math.floor(y * sample.height / height)));
    return (sy * sample.width + sx) * 4;
  };
  const colorDifference = (first: ImageData, a: number, second: ImageData, b: number) => Math.max(
    Math.abs(first.data[a] - second.data[b]),
    Math.abs(first.data[a + 1] - second.data[b + 1]),
    Math.abs(first.data[a + 2] - second.data[b + 2]),
  );
  if (reference.width !== sample.width || reference.height !== sample.height) return;

  for (const landmarks of hands) {
    const points = landmarks.map(({ x, y }) => ({ x: x * width, y: y * height }));
    const span = Math.hypot(points[5].x - points[17].x, points[5].y - points[17].y);
    if (span < 4) continue;
    // A detected hand can be entirely absent from the person mask. Use the
    // palm landmarks and current image colors as independent evidence.
    const palm = palmOutline.map((index) => points[index]);
    const center = {
      x: (points[0].x + points[5].x + points[17].x) / 3,
      y: (points[0].y + points[5].y + points[17].y) / 3,
    };
    const centerIndex = sampleIndex(center.x, center.y);
    if (colorDifference(reference, centerIndex, sample, centerIndex) <= 30) {
      const left = Math.max(0, Math.floor(Math.min(...palm.map(({ x }) => x))));
      const right = Math.min(width - 1, Math.ceil(Math.max(...palm.map(({ x }) => x))));
      const top = Math.max(0, Math.floor(Math.min(...palm.map(({ y }) => y))));
      const bottom = Math.min(height - 1, Math.ceil(Math.max(...palm.map(({ y }) => y))));
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const px = x + 0.5, py = y + 0.5;
          let inside = false;
          let edge = Infinity;
          for (let i = 0; i < palm.length; i++) {
            const a = palm[i], b = palm[(i + 1) % palm.length];
            const dx = b.x - a.x, dy = b.y - a.y;
            if ((a.y > py) !== (b.y > py) && px < a.x + (py - a.y) * dx / dy) inside = !inside;
            const fraction = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / Math.max(0.01, dx * dx + dy * dy)));
            edge = Math.min(edge, Math.hypot(px - a.x - dx * fraction, py - a.y - dy * fraction));
          }
          if (!inside) continue;
          const color = sampleIndex(px, py);
          const difference = colorDifference(sample, color, reference, centerIndex);
          const match = Math.max(0, Math.min(1, (72 - difference) / 38));
          const opacity = Math.min(1, edge / 1.4);
          const offset = (y * width + x) * 4;
          const value = Math.max(pixels[offset], 255 * opacity * match);
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value;
        }
      }
    }
    for (const [finger, joints] of fingers.entries()) {
      for (let i = 1; i < joints.length; i++) {
        const a = points[joints[i - 1]], b = points[joints[i]];
        const dx = b.x - a.x, dy = b.y - a.y;
        const length2 = dx * dx + dy * dy;
        if (length2 < 0.5) continue;
        const middle = sampleIndex((a.x + b.x) / 2, (a.y + b.y) / 2);
        if (colorDifference(reference, middle, sample, middle) > 30) continue;
        const radius = Math.max(1, Math.min(span * (finger === 0 ? 0.13 : 0.108), Math.sqrt(length2) * 0.7));
        const tip = i === joints.length - 1;
        const left = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
        const right = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + radius));
        const top = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
        const bottom = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + radius));
        for (let y = top; y <= bottom; y++) {
          for (let x = left; x <= right; x++) {
            const px = x + 0.5, py = y + 0.5;
            const fraction = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / length2));
            const cx = a.x + dx * fraction, cy = a.y + dy * fraction;
            const distance = Math.hypot(px - cx, py - cy);
            const edge = radius * (tip ? 1 - 0.25 * fraction : 1);
            if (distance >= edge) continue;
            const offset = (y * width + x) * 4;
            const color = sampleIndex(px, py);
            const center = sampleIndex(a.x + dx * Math.max(0.16, Math.min(0.84, fraction)),
              a.y + dy * Math.max(0.16, Math.min(0.84, fraction)));
            const difference = colorDifference(sample, color, reference, center);
            const match = Math.max(0, Math.min(1, (54 - difference) / 26));
            const opacity = Math.max(0, Math.min(1, (edge - distance) / Math.max(1, edge * 0.42)));
            const value = Math.max(pixels[offset], 255 * opacity * match);
            pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value;
          }
        }
      }
    }
  }
}
