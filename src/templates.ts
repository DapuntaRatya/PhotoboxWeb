import catalog from './template-catalog.json';
import { appPath } from './paths';

export type Template = { id: string; label: string; group: string; art?: string };
export type Background = Template & { colors: string[] };
export type Frame = Template & { paper: string; ink: string; border: string };
export const backgrounds: readonly Background[] = catalog.backgrounds;
export const frames: readonly Frame[] = catalog.frames;
const backgroundById = new Map(backgrounds.map((item) => [item.id, item]));
const frameById = new Map(frames.map((item) => [item.id, item]));
export const backgroundPreset = (id: string) => backgroundById.get(id) ?? backgrounds[0];
export const framePreset = (id: string) => frameById.get(id) ?? frameById.get('paper')!;

const previewAssets = new Map<string, HTMLImageElement>();
const captureAssets = new Map<string, HTMLImageElement>();
export const templateThumbnail = (url: string) => url.endsWith('.webp') ? url.replace('.webp', '-thumb.webp') : url;

export function templateAsset(url: string, highResolution = false) {
  const useUhd = highResolution && url.endsWith('.webp');
  const assets = useUhd ? captureAssets : previewAssets;
  const limit = useUhd ? 4 : 8;
  let image = assets.get(url);
  if (image) {
    assets.delete(url);
  } else {
    if (assets.size >= limit) assets.delete(assets.keys().next().value!);
    image = new Image();
    image.src = appPath(useUhd ? url.replace('.webp', '-uhd.webp') : url);
  }
  assets.set(url, image);
  return image;
}

export async function loadTemplateArt(background?: string, frame?: string, highResolution = false) {
  const preset = frame ? framePreset(frame) : undefined;
  const urls = [background ? backgroundPreset(background).art : undefined, preset?.art];
  await Promise.all(urls.map(async (url) => {
    if (!url) return;
    const image = templateAsset(url, highResolution);
    try {
      await image.decode();
    } catch (error) {
      const assets = highResolution && url.endsWith('.webp') ? captureAssets : previewAssets;
      if (assets.get(url) === image) assets.delete(url);
      throw error;
    }
  }));
}
