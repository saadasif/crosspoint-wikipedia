import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { mockWikipedia, selectArticle } from './fixtures';

const wrapper = (body: string, display = false) => `<span class="mwe-math-element${display ? ' mwe-math-element-display' : ''}"><math xmlns="http://www.w3.org/1998/Math/MathML">${body}</math></span>`;
const fraction = (value: number) => wrapper(`<mfrac><mn>${value}</mn><mi>x</mi></mfrac>`, true);

async function book(page: import('@playwright/test').Page, html: string) {
  await mockWikipedia(page, html);
  await page.goto('/files');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  const file = await event;
  await file.saveAs(test.info().outputPath('equations.epub'));
  const zip = await JSZip.loadAsync(await readFile((await file.path())!), { checkCRC32: true });
  const sections = await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')));
  return { zip, sections, text: sections.join('') };
}

test('Normal distribution density renders as a nonblank PNG with photos disabled and inline symbols remain text', async ({ page }) => {
  const { zip, text } = await book(page, await readFile('tests/fixtures/normal-distribution-math.html', 'utf8'));
  const images = Object.keys(zip.files).filter(name => name.endsWith('.png'));
  expect(images).toHaveLength(1);
  expect(text).toContain('equations/equation-1.png');
  expect(text).toContain('<i>μ</i>');
  expect(text).toContain('<i>σ</i><sup><span>2</span></sup>');
  expect(text).toContain('The article continues after the equation.');
  expect(text).not.toMatch(/\\displaystyle|\\frac|Equation omitted|data-wp-math|<math/);
  expect(await zip.file('EPUB/content.opf')!.async('string')).toContain('media-type="image/png"');
  const result = await page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let ink = 0, colored = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 200) ink++;
      if (pixels[i] !== pixels[i + 1] || pixels[i] !== pixels[i + 2]) colored++;
    }
    return { width: image.width, height: image.height, ink, colored };
  }, await zip.file(images[0])!.async('base64'));
  expect(result.width).toBeLessThanOrEqual(448);
  expect(result.height).toBeLessThanOrEqual(560);
  expect(result.ink).toBeGreaterThan(100);
  expect(result.colored).toBe(0);
});

test('equations render offline, deduplicate assets, and do not request external MathML resources', async ({ page }) => {
  const unwanted: string[] = [];
  await page.route('https://evil.example/**', route => { unwanted.push(route.request().url()); return route.abort(); });
  const { zip, text } = await book(page, `<p>Before ${fraction(1)} between ${fraction(1)} after.</p>` + wrapper('<mglyph src="https://evil.example/a.png"/>') + wrapper('<mi href="https://evil.example/b" onclick="alert(1)">x</mi>'));
  expect(Object.keys(zip.files).filter(name => name.endsWith('.png'))).toHaveLength(1);
  expect(text.match(/src="equations\/equation-1.png"/g)).toHaveLength(2);
  expect(text).toContain('Equation omitted');
  expect(text).not.toMatch(/evil\.example|onclick|<a\b|<svg\b|data-wp-math/);
  expect(unwanted).toEqual([]);
});

test('equation limits are separate from photos and produce explicit notices without truncating prose', async ({ page }) => {
  const { zip, sections, text } = await book(page, '<p>Beginning of a math-heavy article.</p>' + Array.from({ length: 257 }, (_, index) => fraction(index)).join('') + '<p>End of the article remains readable.</p>');
  const count = Object.keys(zip.files).filter(name => name.endsWith('.png')).length;
  expect(count).toBeGreaterThan(20);
  expect(count).toBeLessThanOrEqual(256);
  expect(text).toContain('Equation omitted');
  expect(text).toContain('End of the article remains readable.');
  for (const section of sections) expect(Buffer.byteLength(section)).toBeLessThan(26000);
});

test('malformed and excessively wide equations get notices instead of TeX or tiny images', async ({ page }) => {
  const { zip, text } = await book(page, '<p>Readable explanation.</p>' + wrapper('<mfrac><mi>x</mi></mfrac>', true) + wrapper(`<mi>${'x'.repeat(1000)}</mi>`, true));
  expect(Object.keys(zip.files).filter(name => name.endsWith('.png'))).toHaveLength(0);
  expect(text.match(/Equation omitted/g)).toHaveLength(2);
  expect(text).toContain('Readable explanation.');
  expect(text).not.toContain('x'.repeat(1000));
});

test('wide equations scale to the exact reader pixel bounds', async ({ page }) => {
  const { zip } = await book(page, '<p>Wide formulas remain readable within the screen.</p>' + Array.from({ length: 13 }, (_, index) => wrapper(`<mfrac><mi>${'x'.repeat(56 + index)}</mi><mi>y</mi></mfrac>`, true)).join('') + '<p>A native MathML symbol: <math><mi>μ</mi></math>.</p>');
  const images = Object.keys(zip.files).filter(name => name.endsWith('.png'));
  expect(images).toHaveLength(13);
  const widths: number[] = [];
  for (const name of images) {
    const bytes = await zip.file(name)!.async('nodebuffer');
    widths.push(bytes.readUInt32BE(16));
    expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(448);
    expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(560);
  }
  expect(Math.max(...widths)).toBe(448);
});

test('missing equation tools report a recoverable error instead of exporting raw source', async ({ page }) => {
  await mockWikipedia(page, '<p>A mathematical article.</p>' + fraction(1));
  await page.route('**/plugin?**', route => new URL(route.request().url()).searchParams.get('file') === 'equations.js' ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue());
  await page.goto('/files');
  await selectArticle(page);
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Equation tools unavailable. Reinstall the plugin.');
  await expect(page.getByRole('button', { name: 'Download EPUB', exact: true })).toBeEnabled();
  expect(downloaded).toBe(false);
});

test('cancelling typesetting stops the export and restores controls', async ({ page }) => {
  await mockWikipedia(page, '<p>A long mathematical article.</p>' + Array.from({ length: 257 }, (_, index) => fraction(index)).join(''));
  await page.goto('/files');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Typesetting equation' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled.');
  await expect(page.getByRole('button', { name: 'Download EPUB', exact: true })).toBeEnabled();
  expect(downloaded).toBe(false);
});

test('equation image decoding overlaps within a three-job bound and preserves source order', async ({ page }) => {
  await mockWikipedia(page, `<p>Several distinct equations should be prepared concurrently in a bounded batch.</p>${[1, 2, 1, 3, 4, 5].map(fraction).join('')}`);
  await page.goto('/files');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  await page.evaluate(() => {
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    const stats = { active: 0, maximum: 0 };
    (window as Window & { equationJobs?: typeof stats }).equationJobs = stats;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(value: string) {
        if (!value.startsWith('blob:')) { src.set!.call(this, value); return; }
        stats.maximum = Math.max(stats.maximum, ++stats.active);
        this.addEventListener('load', () => stats.active--, { once: true });
        this.addEventListener('error', () => stats.active--, { once: true });
        setTimeout(() => src.set!.call(this, value), 50);
      },
    });
  });
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  const file = await pending;
  const zip = await JSZip.loadAsync(await readFile((await file.path())!));
  const text = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(await page.evaluate(() => (window as Window & { equationJobs?: { maximum: number } }).equationJobs!.maximum)).toBe(3);
  expect([...text.matchAll(/src="equations\/equation-(\d+)\.png"/g)].map(match => Number(match[1]))).toEqual([1, 2, 1, 3, 4, 5]);
});
