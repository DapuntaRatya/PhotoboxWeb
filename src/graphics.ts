import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { LiveMask } from './live-mask';
import { type Filters, type Layout, type Person } from './types';
import formats from './photo-formats.json';
import { backgroundPreset, framePreset, loadTemplateArt, templateAsset } from './templates';

export function canvas(width = 1, height = 1) {
  return Object.assign(document.createElement('canvas'), { width, height });
}

export function context(target: HTMLCanvasElement, readback = false) {
  const ctx = target.getContext('2d', { willReadFrequently: readback });
  if (!ctx) throw Error('Canvas tidak tersedia.');
  return ctx;
}

function resize(target: HTMLCanvasElement, width: number, height: number) {
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
}

export const encode = (source: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob>((resolve, reject) =>
  source.toBlob((blob) => blob?.type === type ? resolve(blob) : reject(Error('Gambar gagal dibuat.')), type, quality));

export function decode(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(Error('Gambar tidak dapat dibaca.')); };
    img.src = url;
  });
}

export const digest = async (blob: Blob) => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
  (byte) => byte.toString(16).padStart(2, '0'),
).join('');

const vertex = `
attribute vec2 p;
varying vec2 uv;
void main() {
  gl_Position = vec4(p, 0.0, 1.0);
  uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
}`;
const fragment = `
precision mediump float;
varying vec2 uv;
uniform sampler2D frame;
uniform sampler2D matte;
uniform vec2 edgeStep;
uniform bool cleanEdges;
uniform vec3 light;
uniform vec3 color;
void sampleForeground(vec2 offset, inout vec3 sum, inout float total) {
  vec2 p = uv + offset;
  float weight = smoothstep(0.85, 0.98, texture2D(matte, p).r);
  sum += weight * texture2D(frame, p).rgb;
  total += weight;
}
void main() {
  vec3 rgb = texture2D(frame, uv).rgb;
  if (cleanEdges) {
    float opacity = texture2D(matte, uv).r;
    if (opacity > 0.06 && opacity < 0.97) {
      vec3 foreground = vec3(0.0);
      float weight = 0.0;
      sampleForeground(vec2(edgeStep.x, 0.0), foreground, weight);
      sampleForeground(vec2(-edgeStep.x, 0.0), foreground, weight);
      sampleForeground(vec2(0.0, edgeStep.y), foreground, weight);
      sampleForeground(vec2(0.0, -edgeStep.y), foreground, weight);
      if (weight < 0.5) {
        sampleForeground(edgeStep * vec2(2.0, 1.5), foreground, weight);
        sampleForeground(edgeStep * vec2(-2.0, 1.5), foreground, weight);
        sampleForeground(edgeStep * vec2(2.0, -1.5), foreground, weight);
        sampleForeground(edgeStep * vec2(-2.0, -1.5), foreground, weight);
      }
      if (weight > 0.0) rgb = mix(rgb, foreground / weight, min(1.0, weight) * (1.0 - opacity) * 0.85);
    }
  }
  rgb = (rgb * exp2(light.x * 0.20) + light.y * 0.045 - 0.5) * (1.0 + light.z * 0.12) + 0.5;
  rgb = mix(vec3(dot(rgb, vec3(0.2126, 0.7152, 0.0722))), rgb, 1.0 + color.x * 0.16);
  rgb += vec3(color.y * 0.034 + color.z * 0.017, -color.z * 0.029, -color.y * 0.034 + color.z * 0.017);
  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

export class ColorRenderer {
  readonly output = canvas();
  private gl: WebGLRenderingContext;
  private light: WebGLUniformLocation | null;
  private color: WebGLUniformLocation | null;
  private edgeStep: WebGLUniformLocation | null;
  private cleanEdges: WebGLUniformLocation | null;

  constructor() {
    const gl = this.output.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) throw Error('WebGL dibutuhkan untuk Camera Enhancement.');
    this.gl = gl;
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error('Shader kamera gagal dimuat.');
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    for (const unit of [gl.TEXTURE0, gl.TEXTURE1]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.uniform1i(gl.getUniformLocation(program, 'matte'), 1);
    this.edgeStep = gl.getUniformLocation(program, 'edgeStep');
    this.cleanEdges = gl.getUniformLocation(program, 'cleanEdges');
    this.light = gl.getUniformLocation(program, 'light');
    this.color = gl.getUniformLocation(program, 'color');
  }

  draw(source: TexImageSource, width: number, height: number, values: Filters, mask?: TexImageSource) {
    const gl = this.gl;
    if (gl.isContextLost()) throw Error('WebGL kamera terputus. Muat ulang halaman untuk mencoba lagi.');
    resize(this.output, width, height);
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(this.cleanEdges, Number(Boolean(mask)));
    if (mask) {
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      const radius = Math.max(width, height) / 256;
      gl.uniform2f(this.edgeStep, radius / width, radius / height);
    }
    gl.uniform3f(this.light, values.exposure, values.brightness, values.contrast);
    gl.uniform3f(this.color, values.saturation, values.temperature, values.tint);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  close() { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}

export async function makeSegmenter(runningMode: 'VIDEO' | 'IMAGE') {
  const files = await FilesetResolver.forVisionTasks('/vision');
  return ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/vision/person.tflite', delegate: 'CPU' },
    runningMode, outputCategoryMask: false, outputConfidenceMasks: true,
  });
}

export function paintMask(target: HTMLCanvasElement, mask: LiveMask) {
  resize(target, mask.width, mask.height);
  const ctx = context(target);
  const pixels = ctx.createImageData(mask.width, mask.height);
  pixels.data.set(mask.pixels);
  ctx.putImageData(pixels, 0, 0);
}

const edgeDirections = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

export function refinePhotoMask(source: HTMLCanvasElement, mask: HTMLCanvasElement) {
  const scale = Math.min(1, 768 / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale)), h = Math.max(1, Math.round(source.height * scale));
  const alpha = canvas(w, h), spill = canvas(w, h);
  const alphaCtx = context(alpha);
  alphaCtx.drawImage(mask, 0, 0, w, h);
  const confidence = alphaCtx.getImageData(0, 0, w, h).data;
  const spillCtx = context(spill);
  spillCtx.drawImage(source, 0, 0, w, h);
  const colors = spillCtx.getImageData(0, 0, w, h).data;
  const matte = alphaCtx.createImageData(w, h), correction = spillCtx.createImageData(w, h);
  const step = Math.max(2, Math.round(Math.max(w, h) / 240));
  const radii = [step, step * 2, step * 4, step * 6];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let opacity = confidence[i] / 255;
      if (opacity > 0.02 && opacity < 0.98) {
        let foreground = -1, background = -1, bestForeground = Infinity, bestBackground = Infinity;
        for (const radius of radii) {
          for (const [dx, dy] of edgeDirections) {
            const nx = x + dx * radius, ny = y + dy * radius;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const j = (ny * w + nx) * 4;
            if (confidence[j] < 246 && confidence[j] > 9) continue;
            const distance = (colors[i] - colors[j]) ** 2 + (colors[i + 1] - colors[j + 1]) ** 2 +
              (colors[i + 2] - colors[j + 2]) ** 2 + 9 * radius ** 2;
            if (confidence[j] >= 246 && distance < bestForeground) {
              foreground = j;
              bestForeground = distance;
            } else if (confidence[j] <= 9 && distance < bestBackground) {
              background = j;
              bestBackground = distance;
            }
          }
          if (foreground >= 0 && background >= 0) break;
        }
        if (foreground >= 0 && background >= 0) {
          const red = colors[foreground] - colors[background];
          const green = colors[foreground + 1] - colors[background + 1];
          const blue = colors[foreground + 2] - colors[background + 2];
          const separation = red * red + green * green + blue * blue;
          if (separation > 1200) {
            // Estimate coverage from nearby colors only where the model is unsure.
            const projection = ((colors[i] - colors[background]) * red + (colors[i + 1] - colors[background + 1]) * green +
              (colors[i + 2] - colors[background + 2]) * blue) / separation;
            const coverage = Math.max(0, Math.min(1, projection));
            const residual = (colors[i] - colors[background] - coverage * red) ** 2 +
              (colors[i + 1] - colors[background + 1] - coverage * green) ** 2 +
              (colors[i + 2] - colors[background + 2] - coverage * blue) ** 2;
            const weight = 0.8 * Math.max(0, 1 - residual / 1800);
            opacity += (coverage - opacity) * weight;
            if (opacity > 0.02) {
              correction.data[i] = colors[foreground];
              correction.data[i + 1] = colors[foreground + 1];
              correction.data[i + 2] = colors[foreground + 2];
              correction.data[i + 3] = Math.round(255 * weight * (1 - coverage));
            }
          }
        }
      }
      matte.data[i] = matte.data[i + 1] = matte.data[i + 2] = 255;
      matte.data[i + 3] = Math.round(opacity * 255);
    }
  }
  alphaCtx.putImageData(matte, 0, 0);
  spillCtx.putImageData(correction, 0, 0);
  return { alpha, spill };
}

export function readMatte(mask: CanvasRenderingContext2D) {
  const pixels = mask.getImageData(0, 0, mask.canvas.width, mask.canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i + 3] = (pixels.data[i] - 16) * 255 / 223;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
  }
  return pixels;
}

export class MatteDecoder {
  readonly output = canvas();
  private mask = canvas();
  private alpha = canvas();

  constructor(private maxMaskSize = 384) {}

  draw(source: CanvasImageSource, width: number, height: number) {
    const half = Math.floor(width / 2);
    if (!half || !height) return;
    const scale = Math.min(1, this.maxMaskSize / Math.max(half, height));
    const w = Math.max(1, Math.round(half * scale)), h = Math.max(1, Math.round(height * scale));
    resize(this.mask, w, h);
    resize(this.alpha, w, h);
    const mask = context(this.mask, true);
    const alpha = context(this.alpha);
    resize(this.output, half, height);
    const ctx = context(this.output);
    mask.drawImage(source, half, 0, half, height, 0, 0, this.mask.width, this.mask.height);
    alpha.putImageData(readMatte(mask), 0, 0);
    ctx.clearRect(0, 0, half, height);
    ctx.drawImage(source, 0, 0, half, height, 0, 0, half, height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.alpha, 0, 0, half, height);
    ctx.globalCompositeOperation = 'source-over';
  }
}

export function cover(ctx: CanvasRenderingContext2D, image: HTMLImageElement | HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  const scale = Math.max(w / width, h / height);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(image, (width - sw) / 2, (height - sh) / 2, sw, sh, x, y, w, h);
}

export function dimensions(ratio: Layout['ratio'], max: number) {
  const [x, y] = formats.ratios[ratio];
  const unit = Math.floor(max / Math.max(x, y));
  return [unit * x, unit * y] as const;
}

const frameLayers = new WeakMap<HTMLImageElement, HTMLCanvasElement>();

function frameLayer(art: HTMLImageElement, width: number, height: number) {
  const cached = frameLayers.get(art);
  if (cached?.width === width && cached.height === height) return cached;
  const layer = canvas(width, height);
  const ctx = context(layer);
  ctx.imageSmoothingQuality = 'high';
  // Keep corner scale proportional to the shorter side and leave the center open.
  const rim = Math.max(1, Math.round(Math.min(width, height) * 0.13));
  const slice = Math.round(art.naturalWidth * 0.20);
  const source = [0, slice, art.naturalWidth - slice, art.naturalWidth];
  const horizontal = [0, rim, width - rim, width];
  const vertical = [0, rim, height - rim, height];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      if (row === 1 && column === 1) continue;
      ctx.drawImage(art, source[column], source[row], source[column + 1] - source[column], source[row + 1] - source[row],
        horizontal[column], vertical[row], horizontal[column + 1] - horizontal[column], vertical[row + 1] - vertical[row]);
    }
  }
  frameLayers.set(art, layer);
  return layer;
}

export function compose(target: HTMLCanvasElement, layout: Layout, layers: ReadonlyMap<string, HTMLCanvasElement | HTMLImageElement>,
  custom?: HTMLImageElement, editing?: { seat: string; person: Person }, highResolution = false) {
  const ctx = context(target);
  const { width: w, height: h } = target;
  ctx.imageSmoothingQuality = highResolution ? 'high' : 'medium';
  const preset = backgroundPreset(layout.background);
  const gradient = ctx.createLinearGradient(0, 0, w * 0.4, h);
  gradient.addColorStop(0, preset.colors[0]);
  gradient.addColorStop(1, preset.colors[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  const backdrop = custom ?? (preset.art ? templateAsset(preset.art, highResolution) : undefined);
  if (backdrop?.naturalWidth) cover(ctx, backdrop, 0, 0, w, h);
  for (const seat of layout.order) {
    const image = layers.get(seat);
    if (!image) continue;
    const person = editing?.seat === seat ? editing.person : layout.people[seat];
    const width = w * person.scale, height = h * person.scale;
    cover(ctx, image, w * person.x - width / 2, h * person.y - height / 2, width, height);
  }
  const art = framePreset(layout.frame).art;
  const ornament = art ? templateAsset(art, highResolution) : undefined;
  if (ornament?.naturalWidth) ctx.drawImage(frameLayer(ornament, w, h), 0, 0);
}

export async function composeStrip(photos: Blob[], layout: Layout) {
  const { rows, columns } = formats.strips[layout.strip];
  const pad = 48, gap = 24, footer = 104;
  const [ratioWidth, ratioHeight] = formats.ratios[layout.ratio];
  const unit = Math.floor(Math.min(784 / ratioWidth, 1000 / ratioHeight));
  const tileWidth = unit * ratioWidth, tileHeight = unit * ratioHeight;
  const width = pad * 2 + columns * tileWidth + (columns - 1) * gap;
  const target = canvas(width, pad * 2 + rows * tileHeight + (rows - 1) * gap + footer);
  const ctx = context(target);
  ctx.imageSmoothingQuality = 'high';
  const frame = framePreset(layout.frame);
  await loadTemplateArt(undefined, frame.id, true);
  ctx.fillStyle = frame.paper;
  ctx.fillRect(0, 0, target.width, target.height);
  const images = await Promise.all(photos.map(decode));
  for (const [index, image] of images.entries()) {
    const x = pad + (index % columns) * (tileWidth + gap), y = pad + Math.floor(index / columns) * (tileHeight + gap);
    const scale = Math.min(tileWidth / image.naturalWidth, tileHeight / image.naturalHeight);
    const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.fillStyle = frame.border;
    ctx.fillRect(x, y, tileWidth, tileHeight);
    ctx.drawImage(image, x + (tileWidth - w) / 2, y + (tileHeight - h) / 2, w, h);
  }
  if (!frame.art) return target;
  const art = templateAsset(frame.art, true);
  const { naturalWidth: artWidth, naturalHeight: artHeight } = art;
  const crop = Math.round(artHeight * 0.16);
  const corner = Math.round(artWidth * 0.34);
  // Sample the corners separately so floral details and scrollwork do not stretch along the strip.
  for (const [sx, dx] of [[0, 0], [artWidth - corner, width - 102]]) {
    ctx.drawImage(art, sx, 0, corner, crop, dx, 0, 102, pad);
    ctx.drawImage(art, sx, artHeight - crop, corner, crop, dx, target.height - pad, 102, pad);
  }
  return target;
}
