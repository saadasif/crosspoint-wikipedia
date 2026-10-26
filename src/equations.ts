import { decodeImage } from './image-decode';
import { ASSET_CONCURRENCY, EQUATION_LIMIT, EQUATION_BYTES } from './limits';
import { typeset } from './mathjax.mjs';
import { type Article, type ImageAsset, type Report, checkCancelled } from './types';

const NS = 'http://www.w3.org/1998/Math/MathML';
const TAGS = new Set('math semantics mrow mi mn mo mtext ms mstyle mspace mfrac msqrt mroot msup msub msubsup mover munder munderover mtable mtr mtd mlabeledtr mfenced menclose mpadded mphantom mmultiscripts mprescripts none'.split(' '));
const ATTRS = new Set('display displaystyle scriptlevel mathvariant stretchy fence separator form accent accentunder linethickness bevelled columnalign rowalign columnspacing rowspacing align side width height depth lspace rspace notation voffset open close separators'.split(' '));
const OMITTED = '[Equation omitted: unavailable or too large for this edition.]';

// Copy only mathematical structure: no styles, URLs, foreign HTML or annotations.
function sanitize(input: Element, doc: Document): Element {
  let count = 0;
  function copy(node: Element, depth: number): Element {
    if (++count > 1500 || depth > 40 || !TAGS.has(node.localName)) throw new Error('Unsupported equation');
    const el = doc.createElementNS(NS, node.localName);
    for (const attr of Array.from(node.attributes)) if (ATTRS.has(attr.name)) el.setAttribute(attr.name, attr.value);
    for (const child of Array.from(node.childNodes)) {
      if (child instanceof Element) {
        if (child.localName === 'annotation' || child.localName === 'annotation-xml') continue;
        el.append(copy(child, depth + 1));
      } else if (child.nodeType === Node.TEXT_NODE) el.append(child.textContent || '');
    }
    return el;
  }
  const result = copy(input, 0);
  if (!result.textContent?.trim()) throw new Error('Empty equation');
  for (const node of [result, ...Array.from(result.querySelectorAll('*'))]) {
    const arity = ['mfrac', 'mroot', 'msup', 'msub', 'mover', 'munder'].includes(node.localName) ? 2 : ['msubsup', 'munderover'].includes(node.localName) ? 3 : 0;
    if (arity && node.children.length !== arity) throw new Error('Missing equation argument');
  }
  if (new XMLSerializer().serializeToString(result).length > 64000) throw new Error('Equation too large');
  return result;
}

// Keep simple inline notation in the text flow. Layout-dependent notation is
// rendered by MathJax instead of guessing at the meaning of TeX commands.
function inline(math: Element, doc: Document): HTMLElement | undefined {
  const output = doc.createElement('span');
  output.className = 'wp-inline-math';
  function append(node: Element, parent: HTMLElement, depth: number, inherited?: string): void {
    if (depth > 15) throw new Error('Complex inline equation');
    const children = Array.from(node.children);
    const tag = node.localName;
    const variant = node.getAttribute('mathvariant') || inherited;
    if (variant && !['normal', 'italic', 'bold'].includes(variant)) throw new Error('Math alphabet');
    if (tag === 'math' || tag === 'mrow' || tag === 'mstyle' || tag === 'semantics') {
      const target = variant === 'bold' ? doc.createElement('strong') : parent;
      if (target !== parent) parent.append(target);
      for (const child of children) append(child, target, depth + 1, variant);
    } else if (['mi', 'mn', 'mo', 'mtext'].includes(tag)) {
      const text = node.textContent || '';
      // Mathematical alphabet codepoints need exact font support; use an image.
      if (/[\u{1d400}-\u{1d7ff}]/u.test(text)) throw new Error('Math alphabet');
      const el = doc.createElement(variant === 'bold' ? 'strong' : tag === 'mi' && variant !== 'normal' && text.length === 1 ? 'i' : 'span');
      el.textContent = text;
      parent.append(el);
    } else if (['msub', 'msup', 'msubsup'].includes(tag)) {
      if (children.length !== (tag === 'msubsup' ? 3 : 2)) throw new Error('Missing script');
      if (children[0].querySelectorAll('mi,mn,mo').length > 1) throw new Error('Complex script base');
      append(children[0], parent, depth + 1, variant);
      for (let index = 1; index < children.length; index++) {
        const script = doc.createElement(tag === 'msup' || index === 2 ? 'sup' : 'sub');
        append(children[index], script, depth + 1, variant);
        parent.append(script);
      }
    } else if (tag === 'mspace') parent.append(' ');
    else throw new Error('Equation needs layout');
  }
  try {
    append(math, output, 0);
    if (!output.textContent?.trim() || output.textContent.length > 80) return;
    return output;
  } catch { return; }
}

export function normalize(root: ParentNode, doc: Document): void {
  for (const wrapper of root.querySelectorAll('.mwe-math-element,math')) {
    if (!root.contains(wrapper)) continue;
    const placeholder = doc.createElement('span');
    placeholder.textContent = OMITTED;
    try {
      const original = wrapper.localName === 'math' ? wrapper : wrapper.querySelector('math');
      if (!original) throw new Error('Missing MathML');
      const math = sanitize(original, doc);
      const display = wrapper.matches('.mwe-math-element-display') || math.getAttribute('display') === 'block';
      const simple = !display && inline(math, doc);
      if (simple) { wrapper.replaceWith(simple); continue; }
      placeholder.setAttribute('data-wp-math', new XMLSerializer().serializeToString(math));
    } catch { /* Keep an explicit notice, never raw TeX. */ }
    wrapper.replaceWith(placeholder);
  }
}

async function png(math: Element, signal: AbortSignal): Promise<{ data: Uint8Array; width: number; height: number }> {
  const svg = typeset(new XMLSerializer().serializeToString(math));
  const box = svg.getAttribute('viewBox')?.split(/\s+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error('Invalid equation size');
  const scale = Math.min(24 / 1000, 448 / box[2], 560 / box[3]);
  if (scale * 1000 < 12) throw new Error('Equation would be unreadable');
  const width = Math.max(1, Math.min(448, Math.ceil(box[2] * scale)));
  const height = Math.max(1, Math.min(560, Math.ceil(box[3] * scale)));
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('color', '#000');
  const image = await decodeImage(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }), signal, 5000, 'Equation');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  let ink = 0;
  for (let index = 0; index < pixels.data.length; index += 4) {
    const gray = Math.round((pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2]) / 3);
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = gray;
    if (gray < 240) ink++;
  }
  if (!ink) throw new Error('Empty equation image');
  context.putImageData(pixels, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'));
  return { data: new Uint8Array(await blob.arrayBuffer()), width, height };
}

async function renderEquation(source: string, signal: AbortSignal): Promise<Awaited<ReturnType<typeof png>> | undefined> {
  try {
    const parsed = new DOMParser().parseFromString(source, 'application/xml');
    const math = sanitize(parsed.documentElement, document);
    if (math.localName === 'math') return await png(math, signal);
  } catch { /* Keep the omission notice; cancellation is checked after the batch. */ }
}

export async function prepare(root: HTMLElement, article: Article, signal: AbortSignal, report: Report): Promise<ImageAsset[]> {
  const assets: ImageAsset[] = [];
  const cache = new Map<string, { asset: ImageAsset; width: number; height: number } | undefined>();
  let total = 0;
  const nodes = Array.from(root.querySelectorAll('[data-wp-math]'));
  for (let offset = 0; offset < nodes.length; offset += ASSET_CONCURRENCY) {
    checkCancelled(signal);
    report(`Typesetting equations ${offset + 1}–${Math.min(offset + ASSET_CONCURRENCY, nodes.length)} of ${nodes.length}…`);
    const batch = nodes.slice(offset, offset + ASSET_CONCURRENCY);
    const pending = new Map<string, Promise<Awaited<ReturnType<typeof png>> | undefined>>();
    if (assets.length < EQUATION_LIMIT && total < EQUATION_BYTES) {
      for (const node of batch) {
        const source = node.getAttribute('data-wp-math')!;
        if (cache.has(source) || pending.has(source)) continue;
        pending.set(source, renderEquation(source, signal));
      }
    }
    const rendered = new Map(await Promise.all(Array.from(pending, async ([source, task]) => [source, await task] as const)));
    checkCancelled(signal);
    for (const node of batch) {
      const source = node.getAttribute('data-wp-math')!;
      if (!cache.has(source)) {
        const image = rendered.get(source);
        let result;
        if (image && assets.length < EQUATION_LIMIT && total + image.data.length <= EQUATION_BYTES) {
          const asset: ImageAsset = { path: `equations/equation-${assets.length + 1}.png`, data: image.data, mediaType: 'image/png', title: 'Equation', artist: 'Wikipedia contributors', license: article.license.text, licenseUrl: article.license.url, source: article.source };
          result = { asset, width: image.width, height: image.height };
          assets.push(asset);
          total += image.data.length;
        }
        cache.set(source, result);
      }
      const result = cache.get(source);
      const block = root.ownerDocument.createElement('span');
      block.className = 'wp-equation';
      if (result) {
        const image = root.ownerDocument.createElement('img');
        image.src = result.asset.path;
        image.alt = 'Mathematical equation';
        image.width = result.width; image.height = result.height;
        block.append(image);
      } else block.textContent = OMITTED;
      node.replaceWith(block);
    }
    // Let cancellation and progress updates run between batches.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return assets;
}
