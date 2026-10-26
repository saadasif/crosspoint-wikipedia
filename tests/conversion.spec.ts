import { test, expect } from '@playwright/test';
import { mockWikipedia, selectArticle, download } from './fixtures';

async function select(page: import('@playwright/test').Page, html: string) {
  await mockWikipedia(page, html);
  await page.goto('/files');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
}

test('wrapped sections appear independently in EPUB navigation and keep text direction', async ({ page }) => {
  await select(page, '<p>An introduction to a page with nested section wrappers and explicit text direction.</p><section><h2>History</h2><p>Earlier events.</p><section dir="rtl"><div><h2>Culture</h2><p>ثقافة</p></div></section></section>');
  const { zip } = await download(page);
  const nav = await zip.file('EPUB/nav.xhtml')!.async('string');
  expect(nav).toContain('>History</a>');
  expect(nav).toContain('>Culture</a>');
  const culture = await zip.file('EPUB/section-3.xhtml')!.async('string');
  expect(culture).toContain('dir="rtl"');
  expect(culture).toContain('ثقافة');
});

test('two-column tables with long unbroken tokens fit the reader page', async ({ page }) => {
  await select(page, `<p>A compact table should fit the page even when a cell has a long identifier.</p><table><tr><th>Name</th><th>Value</th></tr><tr><td>Identifier</td><td>${'abcdefgh'.repeat(80)}</td></tr></table>`);
  const { zip } = await download(page);
  const html = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(html).toContain('<table');
  const css = await zip.file('EPUB/article.css')!.async('string');
  const preview = await page.context().newPage();
  await preview.setViewportSize({ width: 480, height: 800 });
  await preview.setContent(html.replace(/<link[^>]+>/, `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>`));
  expect(await preview.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480);
  await preview.close();
});

test('split ordered lists respect explicit item numbering', async ({ page }) => {
  const items = Array.from({ length: 60 }, (_, i) => `<li${i === 0 ? ' value="100"' : ''}>${'Long item. '.repeat(100)}</li>`).join('');
  await select(page, `<p>An article with an ordered list whose numbering begins at an explicit value.</p><ol>${items}</ol>`);
  const { zip } = await download(page);
  const sections = await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')));
  const starts = await page.evaluate(sections => sections.flatMap(text => {
    const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    return [...doc.querySelectorAll('ol[start]')].map(list => Number(list.getAttribute('start')));
  }), sections);
  expect(starts.length).toBeGreaterThan(0);
  expect(starts.every(start => start > 100)).toBe(true);
});

test('photo work is bounded to three in flight, deduplicates requests, and commits in article order', async ({ page }) => {
  const photo = (n: number) => `<a href="/wiki/File:Photo${n}.png"><img src="https://upload.wikimedia.org/photo${n}.png" alt="Photo ${n}" width="200" height="200"/></a>`;
  await select(page, `<p>A page with several independent photos and one repeated image for deduplication.</p>${[1, 2, 3, 1, 4, 5, 6].map(photo).join('')}`);
  await page.getByLabel('Include optimized images').check();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  let active = 0, maximum = 0;
  const requested: number[] = [];
  await page.route('https://upload.wikimedia.org/**', async route => {
    const n = Number(route.request().url().match(/photo(\d+)/)![1]);
    requested.push(n);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, n === 1 ? 250 : 100));
    await route.fulfill({ body: Buffer.from(png, 'base64'), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } });
    active--;
  });
  const { zip } = await download(page);
  expect(maximum).toBe(3);
  expect(requested.sort()).toEqual([1, 2, 3, 4, 5, 6]);
  const credits = await zip.file('EPUB/content.opf')!.async('string');
  expect(credits.indexOf('Photo1.png')).toBeLessThan(credits.indexOf('Photo2.png'));
  const html = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(html.match(/src="images\/image-1.jpg"/g)).toHaveLength(2);
  // Saving after downloading reuses the exact completed conversion.
  await page.routeWebSocket('ws://127.0.0.1:4174/', socket => socket.close());
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved to /Wikipedia.');
  expect(requested).toHaveLength(6);
  // Changing photo preferences invalidates that reuse.
  await page.getByLabel('Include optimized images').uncheck();
  const next = await download(page);
  expect(Object.keys(next.zip.files).filter(name => name.startsWith('EPUB/images/'))).toHaveLength(0);
});

for (const noisy of [false, true]) {
  test(`photo ${noisy ? 'byte budget stays below 4 MB' : 'count stops at forty distinct assets'}`, async ({ page }) => {
    const photos = Array.from({ length: 43 }, (_, n) => `<a href="/wiki/File:P${n}.png"><img src="https://upload.wikimedia.org/p${n}.png" alt="Photo ${n}"/></a>`).join('');
    await select(page, `<p>A photo collection exercises the separate count and total byte limits for EPUB assets.</p>${photos}`);
    await page.getByLabel('Include optimized images').check();
    const png = await page.evaluate(noisy => {
      const canvas = document.createElement('canvas'); canvas.width = 448; canvas.height = 560;
      const context = canvas.getContext('2d')!;
      if (noisy) {
        const pixels = context.createImageData(canvas.width, canvas.height);
        let seed = 42;
        for (let i = 0; i < pixels.data.length; i += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = seed >>> 24;
          pixels.data[i + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    }, noisy);
    await page.route('https://upload.wikimedia.org/**', route => route.fulfill({ body: Buffer.from(png, 'base64'), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
    const { zip } = await download(page);
    const images = Object.keys(zip.files).filter(name => name.startsWith('EPUB/images/'));
    if (noisy) {
      const sizes = await Promise.all(images.map(async name => (await zip.file(name)!.async('uint8array')).length));
      expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4000000);
      expect(images.length).toBeGreaterThan(0);
      expect(sizes.reduce((a, b) => a + b, 0) + Math.min(...sizes)).toBeGreaterThan(4000000);
      expect(images.length).toBeLessThan(40);
    } else expect(images).toHaveLength(40);
  });
}
