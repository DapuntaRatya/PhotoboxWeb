import type { ImageSegmenterResult } from '@mediapipe/tasks-vision';

export type LiveMask = { width: number; height: number; pixels: Uint8ClampedArray };

export class LiveMaskFilter {
  private history?: Float32Array;
  private previousLight?: Uint8Array;
  private scratch?: { light: Uint8Array; values: Float32Array; labels: Int32Array; queue: Int32Array };
  private width = 0;
  private height = 0;
  private timestamp = 0;

  apply(result: ImageSegmenterResult, sample: ImageData, time: number, stabilize = true): LiveMask {
    const mask = result.confidenceMasks?.[1] ?? result.confidenceMasks?.[0];
    if (!mask) throw Error('Model tidak menghasilkan mask orang.');
    const { width, height } = mask;
    const length = width * height;
    const input = mask.getAsFloat32Array();
    if (!this.scratch || this.scratch.light.length !== length) {
      this.scratch = { light: new Uint8Array(length), values: new Float32Array(length),
        labels: new Int32Array(length), queue: new Int32Array(length) };
    }
    const { light, values, labels, queue } = this.scratch;
    labels.fill(0);
    const pixels = new Uint8ClampedArray(length * 4);
    const previous = stabilize && this.width === width && this.height === height && time - this.timestamp < 150
      ? this.history : undefined;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const p = (Math.floor(y * sample.height / height) * sample.width + Math.floor(x * sample.width / width)) * 4;
        light[i] = (sample.data[p] * 2 + sample.data[p + 1] * 5 + sample.data[p + 2]) / 8;
        const old = previous?.[i] ?? input[i];
        const motion = previous && this.previousLight ? Math.abs(light[i] - this.previousLight[i]) : 0;
        const change = Math.abs(old - input[i]);
        const historyWeight = Math.max(0, 0.65 - motion / 48 - change * 1.1);
        values[i] = input[i] + (old - input[i]) * historyWeight;
      }
    }

    // Find reliable foreground seeds. Small islands can be recovered only from a retained seed.
    const sizes = [0];
    let largest = 0;
    for (let seed = 0; seed < length; seed++) {
      if (labels[seed] || values[seed] < 0.64) continue;
      const label = sizes.length;
      let head = 0, tail = 1;
      labels[seed] = label;
      queue[0] = seed;
      while (head < tail) {
        const i = queue[head++];
        const x = i % width;
        for (let direction = 0; direction < 4; direction++) {
          const j = direction === 0 ? i - width : direction === 1 ? i + width
            : direction === 2 ? (x > 0 ? i - 1 : -1) : (x + 1 < width ? i + 1 : -1);
          if (j < 0 || j >= length || labels[j] || values[j] < 0.64) continue;
          labels[j] = label;
          queue[tail++] = j;
        }
      }
      sizes.push(tail);
      largest = Math.max(largest, tail);
    }
    const minIsland = Math.max(1, Math.min(largest, Math.max(12, Math.floor(largest * 0.012))));
    let head = 0, tail = 0;
    for (let i = 0; i < length; i++) {
      labels[i] = sizes[labels[i]] >= minIsland ? 1 : 0;
    }
    for (let i = 0; i < length; i++) {
      if (!labels[i]) continue;
      const x = i % width, y = Math.floor(i / width);
      if ((x > 0 && !labels[i - 1]) || (x + 1 < width && !labels[i + 1]) ||
          (y > 0 && !labels[i - width]) || (y + 1 < height && !labels[i + width])) queue[tail++] = i;
    }
    // Let reliable areas reach along fingers. Weak pixels can soften the edge but cannot extend the search.
    while (head < tail) {
      const i = queue[head++];
      const x = i % width, y = Math.floor(i / width);
      for (let dy = -1; dy <= 1; dy++) {
        if (y + dy < 0 || y + dy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (x + dx < 0 || x + dx >= width) continue;
          const j = i + dy * width + dx;
          if (labels[j] === 1 || values[j] <= 0.24) continue;
          const contrast = Math.abs(light[i] - light[j]);
          if (values[j] >= 0.47 || (values[j] >= 0.36 && contrast <= 22)) {
            labels[j] = 1;
            queue[tail++] = j;
          } else if (contrast <= 38 || values[j] >= 0.39) {
            labels[j] = 2;
          }
        }
      }
    }
    for (let i = 0; i < length; i++) {
      const opacity = labels[i] ? Math.max(0, Math.min(1, (values[i] - 0.24) / 0.48)) : 0;
      const grey = opacity * opacity * (3 - 2 * opacity) * 255;
      const offset = i * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = grey;
      pixels[offset + 3] = 255;
    }
    if (stabilize) {
      if (!this.history || this.history.length !== length) this.history = new Float32Array(length);
      if (!this.previousLight || this.previousLight.length !== length) this.previousLight = new Uint8Array(length);
      this.history.set(values);
      this.previousLight.set(light);
      this.width = width;
      this.height = height;
      this.timestamp = time;
    }
    return { width, height, pixels };
  }
}
