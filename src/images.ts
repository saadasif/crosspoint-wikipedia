import { decodeImage } from './image-decode';
import { ASSET_CONCURRENCY, PHOTO_LIMIT, PHOTO_BYTES } from './limits';
import { imageUrl } from './document';
import { type Article, type ImageAsset, type Report, checkCancelled, plainText } from './types';
import { wikiRequest } from './wikipedia';

const IMAGE_MAX_WIDTH = 448;
// Leave additional vertical space for captions on the X4.
const IMAGE_MAX_HEIGHT = 560;

interface Credit {
  artist: string;
  license: string;
  licenseUrl: string;
  source: string;
}

async function imageCredit(title: string, article: Article, signal: AbortSignal): Promise<Credit | undefined> {
  const data = await wikiRequest<{ query: { pages: { imageinfo?: { extmetadata: Record<string, { value: string }> }[] }[] } }>(article.language, {
    action: 'query', titles: title, prop: 'imageinfo', iiprop: 'extmetadata',
  }, signal);
  const meta = data.query.pages[0]?.imageinfo?.[0]?.extmetadata;
  if (!meta) return;
  const licenseUrl = meta.LicenseUrl?.value || '';
  // Omit non-free media: article text and each image have separate licenses.
  const free = /^https?:\/\/(?:www\.)?creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/|publicdomain\/)/.test(licenseUrl);
  const publicDomain = /^(?:Public domain|CC0)/i.test(meta.LicenseShortName?.value || '');
  if (!free && !publicDomain) return;
  return {
    artist: plainText(meta.Artist?.value || meta.Credit?.value || 'See original file page'),
    license: plainText(meta.LicenseShortName?.value || 'See original file page'),
    licenseUrl: free ? licenseUrl.replace(/^http:/, 'https:') : `https://creativecommons.org/publicdomain/${/^CC0/i.test(meta.LicenseShortName?.value || '') ? 'zero' : 'mark'}/1.0/`,
    source: `https://${article.language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

async function jpeg(bytes: ArrayBuffer, signal: AbortSignal): Promise<Uint8Array> {
  const image = await decodeImage(new Blob([bytes]), signal, 10000, 'Image');
  if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 16000000) throw new Error('Image too large.');
  const scale = Math.min(1, IMAGE_MAX_WIDTH / image.naturalWidth, IMAGE_MAX_HEIGHT / image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const gray = Math.round(pixels.data[index] * 0.299 + pixels.data[index + 1] * 0.587 + pixels.data[index + 2] * 0.114);
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = gray;
  }
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Image conversion failed.')), 'image/jpeg', 0.82));
  return new Uint8Array(await blob.arrayBuffer());
}

interface PreparedImage extends Credit { data: Uint8Array; title: string; }

async function prepareImage(src: string, title: string, article: Article, signal: AbortSignal): Promise<PreparedImage | undefined> {
  const request = new AbortController();
  const cancel = () => request.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  try {
    checkCancelled(signal);
    const credit = await imageCredit(title, article, request.signal);
    if (!credit) return;
    const response = await fetch(src, { signal: request.signal, credentials: 'omit' });
    if (!response.ok || Number(response.headers.get('Content-Length')) > 4000000) return;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 4000000) return;
    checkCancelled(request.signal);
    return { data: await jpeg(bytes, request.signal), title, ...credit };
  } catch {
    // Missing or timed-out photos must not prevent reading the article text.
    return;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

export async function prepareImages(root: HTMLElement, article: Article, include: boolean, signal: AbortSignal, report: Report): Promise<{ assets: ImageAsset[]; skipped: number }> {
  const assets: ImageAsset[] = [];
  const cache = new Map<string, ImageAsset | undefined>();
  let skipped = 0;
  let total = 0;
  const images = Array.from(root.querySelectorAll('img'));
  // Fetch/decode at most three photos at once. Commit in document order so
  // network timing cannot decide which images fit the shared EPUB budget.
  for (let offset = 0; offset < images.length; offset += ASSET_CONCURRENCY) {
    checkCancelled(signal);
    const batch = images.slice(offset, offset + ASSET_CONCURRENCY).map(image => ({
      image, src: imageUrl(image.dataset.src || '', article.source), title: image.dataset.file,
    }));
    const pending = new Map<string, Promise<PreparedImage | undefined>>();
    if (include && assets.length < PHOTO_LIMIT && total < PHOTO_BYTES) {
      report(`Optimizing images ${offset + 1}–${Math.min(offset + ASSET_CONCURRENCY, images.length)} of ${images.length}…`);
      for (const { src, title } of batch) {
        if (src && title && !cache.has(src) && !pending.has(src)) pending.set(src, prepareImage(src, title, article, signal));
      }
    }
    const prepared = new Map(await Promise.all(Array.from(pending, async ([src, task]) => [src, await task] as const)));
    checkCancelled(signal);
    for (const { image, src } of batch) {
      if (src && !cache.has(src)) {
        const photo = prepared.get(src);
        let asset: ImageAsset | undefined;
        if (photo && assets.length < PHOTO_LIMIT && total + photo.data.byteLength <= PHOTO_BYTES) {
          asset = { ...photo, path: `images/image-${assets.length + 1}.jpg` };
          assets.push(asset);
          total += asset.data.byteLength;
        }
        cache.set(src, asset);
      }
      const asset = src ? cache.get(src) : undefined;
      if (asset) {
        image.setAttribute('src', asset.path);
        image.removeAttribute('data-src');
        image.removeAttribute('data-file');
      } else {
        if (include) skipped++;
        const alt = image.getAttribute('alt');
        const caption = root.ownerDocument.createElement('span');
        caption.textContent = alt && alt !== 'Article image' ? `[Image: ${alt}]` : '';
        image.replaceWith(caption);
      }
    }
  }
  return { assets, skipped };
}
