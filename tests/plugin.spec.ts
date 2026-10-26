import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { ARTICLE, mockWikipedia, selectArticle, download } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockWikipedia(page);
  await page.goto('/files');
});

test('search, preview and EPUB preserve prose and metadata attribution without reading links', async ({ page }) => {
  await selectArticle(page);
  await expect(page.getByRole('heading', { name: 'Maputo', exact: true })).toBeVisible();
  await expect(page.locator('.cp-wikipedia script')).toHaveCount(0);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip, bytes, filename } = await download(page);
  // Linux WebKit replaces spaces with underscores in suggested download names.
  expect(filename).toMatch(/^Maputo[ _]\[en-57044\]\.epub$/);
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
  expect(bytes.readUInt16LE(8)).toBe(0);
  expect(bytes.subarray(30, 38).toString()).toBe('mimetype');
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
  const names = Object.keys(zip.files).filter(name => name.endsWith('.xhtml'));
  const xml: Record<string, string> = Object.fromEntries(await Promise.all(names.map(async name => [name, await zip.file(name)!.async('string')])));
  const combined = Object.values(xml).join('');
  expect(combined).toContain('São Tomé &amp; Príncipe');
  expect(combined).toContain('Country');
  expect(combined).toContain('Year: ');
  expect(combined).not.toContain('Example photographer');
  expect(combined).not.toMatch(/NAVIGATION TO REMOVE|EDIT TO REMOVE|javascript:|onerror=|<script/);
  const reading = Object.entries(xml).filter(([name]) => /section-\d+\.xhtml$/.test(name)).map(([, text]) => text).join('');
  expect(reading).not.toMatch(/<a[ >]|\[1\]|A cited source|<h[23][^>]*>References/);
  expect(reading).toContain('bad link');
  expect(zip.file('EPUB/sources.xhtml')).toBeNull();
  expect(await zip.file('EPUB/content.opf')!.async('string')).toContain('oldid=12345');
  expect(await zip.file('EPUB/content.opf')!.async('string')).toContain('Wikipedia contributors');
  const errors = await page.evaluate(documents => documents.flatMap(text => {
    const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    return doc.querySelector('parsererror') ? [doc.querySelector('parsererror')!.textContent] : [];
  }), [...Object.values(xml), await zip.file('EPUB/content.opf')!.async('string'), await zip.file('EPUB/toc.ncx')!.async('string'), await zip.file('META-INF/container.xml')!.async('string')]);
  expect(errors).toEqual([]);
  const invalid = await page.evaluate(documents => documents.flatMap(text => {
    const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    return [...doc.querySelectorAll('p div,p p,span div,span ul,strong div,b div')].map(el => el.outerHTML.slice(0, 80));
  }), Object.values(xml));
  expect(invalid).toEqual([]);
});

for (const size of [
  { name: 'landscape', width: 960, height: 600, outputWidth: 448, outputHeight: 280 },
  { name: 'portrait', width: 600, height: 1200, outputWidth: 280, outputHeight: 560 },
]) {
  test(`optimized images preserve ${size.name} proportions, captions and credits`, async ({ page }) => {
    const unwanted: string[] = [];
    const fetched: string[] = [];
    page.on('request', request => { if (request.url().startsWith('http://127.0.0.1:4173/images/')) unwanted.push(request.url()); });
    const png = await page.evaluate(({ width, height }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, width, height);
      return canvas.toDataURL('image/png').split(',')[1];
    }, size);
    await page.route('https://upload.wikimedia.org/**', route => {
      fetched.push(route.request().url());
      return route.fulfill({ body: Buffer.from(png, 'base64'), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await selectArticle(page);
    const { zip } = await download(page);
    const image = await zip.file('EPUB/images/image-1.jpg')!.async('base64');
    const dimensions = await page.evaluate(async data => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, pixel: [...ctx.getImageData(10, 10, 1, 1).data] };
    }, image);
    expect(dimensions.width).toBe(size.outputWidth);
    expect(dimensions.height).toBe(size.outputHeight);
    expect(dimensions.pixel[0]).toBe(dimensions.pixel[1]);
    expect(dimensions.pixel[1]).toBe(dimensions.pixel[2]);
    const credits = await zip.file('EPUB/content.opf')!.async('string');
    expect(credits).toContain('Example photographer');
    expect(credits).toContain('CC BY-SA 4.0');
    const markup = await zip.file('EPUB/section-1.xhtml')!.async('string');
    expect(markup).not.toContain('data-src');
    const figure = await page.evaluate(text => {
      const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
      const figure = doc.querySelector('figure');
      return { image: figure?.querySelector('img')?.getAttribute('src'), caption: figure?.querySelector('figcaption')?.textContent };
    }, markup);
    expect(figure).toEqual({ image: 'images/image-1.jpg', caption: 'A view across Maputo Bay.' });
    expect(unwanted).toEqual([]);
    expect(fetched).toEqual(['https://upload.wikimedia.org/wikipedia/commons/maputo-large.jpg']);
  });
}

test('WebSocket uses the reader protocol and waits for completion', async ({ page }) => {
  const chunks: Buffer[] = [];
  let expected = 0;
  let received = 0;
  await page.routeWebSocket('ws://127.0.0.1:4174/', socket => {
    socket.onMessage(message => {
      if (typeof message === 'string') {
        expect(message).toMatch(/^START:Maputo \[en-57044\]\.epub:\d+:\/Wikipedia$/);
        expected = Number(message.split(':')[2]);
        socket.send('READY');
      } else {
        expect(message.byteLength).toBeLessThanOrEqual(4096);
        chunks.push(message);
        received += message.byteLength;
        if (received === expected) socket.send('DONE');
      }
    });
  });
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved to /Wikipedia.');
  expect(received).toBeGreaterThan(0);
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
});

test('HTTP fallback creates the folder and uploads the EPUB multipart', async ({ page }) => {
  let created = false;
  await page.routeWebSocket('ws://127.0.0.1:4174/', socket => socket.close());
  await page.route('**/api/files?**', route => route.fulfill({ json: [] }));
  await page.route('**/mkdir', async route => {
    expect(route.request().postData()).toBe('name=Wikipedia&path=%2F');
    created = true;
    await route.fulfill({ body: 'Folder created: Wikipedia' });
  });
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const pending = page.waitForResponse('**/upload?**');
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  const response = await pending;
  expect(new URL(response.url()).searchParams.get('path')).toBe('/Wikipedia');
  const received = await response.json();
  expect(received.size).toBeGreaterThan(0);
  expect(received.mimetype).toBe('application/epub+zip');
  expect(received.name).toBe('Maputo [en-57044].epub');
  await expect(page.getByRole('status')).toContainText('Saved to /Wikipedia.');
  expect(created).toBe(true);
});

test('unchecking replacement protects duplicate articles', async ({ page }) => {
  await page.route('**/api/files?**', route => route.fulfill({ json: new URL(route.request().url()).searchParams.get('path') === '/' ? [{ name: 'Wikipedia', isDirectory: true }] : [{ name: 'Maputo [en-57044].epub', isDirectory: false }] }));
  await selectArticle(page);
  await page.getByLabel('Replace existing article').uncheck();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Already on the reader.');
  await expect(page.getByRole('button', { name: 'Add to reader', exact: true })).toBeEnabled();
});

test('a mid-upload disconnect reports failure and never retries via HTTP', async ({ page }) => {
  let http = false;
  await page.route('**/upload?**', async route => { http = true; await route.fulfill({ status: 500 }); });
  await page.routeWebSocket('ws://127.0.0.1:4174/', socket => socket.onMessage(message => {
    if (typeof message === 'string') socket.send('READY');
    else socket.close();
  }));
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('disconnected');
  expect(http).toBe(false);
});

test('mobile article URLs set language and generate bounded UTF-8 filenames', async ({ page }) => {
  await page.getByLabel('Article title or Wikipedia URL').fill(`https://fr.m.wikipedia.org/wiki/${encodeURIComponent('Éléphant '.repeat(20))}`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Ready to import.');
  await expect(page.getByLabel('Wikipedia language', { exact: true })).toHaveValue('fr');
  await page.getByLabel('Include optimized images').uncheck();
  const { filename } = await download(page);
  expect(Buffer.byteLength(filename.normalize('NFC'), 'utf8')).toBeLessThanOrEqual(100);
  expect(filename).toMatch(/\[fr-57044\]\.epub$/);
});

test('long articles split into bounded sections', async ({ page }) => {
  const paragraphs = Array.from({ length: 20 }, (_, i) => `<p id="p${i}">${'Long article text. '.repeat(400)}</p>`).join('');
  await mockWikipedia(page, ARTICLE.replace('<h2 id="References">', `${paragraphs}<h2 id="References">`));
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const sections = Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name));
  expect(sections.length).toBeGreaterThan(5);
  for (const name of sections) expect((await zip.file(name)!.async('string')).length).toBeLessThan(26000);
});

test('rejects non-Wikipedia URLs without making an outbound request', async ({ page }) => {
  await page.getByLabel('Article title or Wikipedia URL').fill('https://en.wikipedia.org.evil.example/wiki/Maputo');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Wikipedia language edition');
});

test('Wikipedia errors are recoverable', async ({ page }) => {
  await page.route('https://*.wikipedia.org/w/api.php?**', route => route.fulfill({ status: 429, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Api-User-Agent' } }));
  await page.getByLabel('Article title or Wikipedia URL').fill('Maputo');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Wikipedia is busy');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
});

test('cancelling a pending Wikipedia request restores the controls', async ({ page }) => {
  await page.route('https://*.wikipedia.org/w/api.php?**', () => {});
  await page.getByLabel('Article title or Wikipedia URL').fill('Maputo');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Searching Wikipedia…');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled.');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
});

test('non-free images are omitted without blocking the article', async ({ page }) => {
  await page.route('https://*.wikipedia.org/w/api.php?**', async route => {
    if (new URL(route.request().url()).searchParams.get('prop') !== 'imageinfo') { await route.fallback(); return; }
    await route.fulfill({ json: { query: { pages: [{ imageinfo: [{ extmetadata: { LicenseShortName: { value: 'Fair use' } } }] }] } }, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Api-User-Agent' } });
  });
  await selectArticle(page);
  const { zip } = await download(page);
  expect(Object.keys(zip.files).some(name => name.endsWith('.jpg'))).toBe(false);
  expect(await zip.file('EPUB/section-1.xhtml')!.async('string')).toContain('[Image: Maputo skyline]');
  await expect(page.getByRole('status')).toContainText('1 images were omitted');
});

test('JSZip loads from the pinned CDN only if missing on the reader', async ({ page }) => {
  await page.evaluate(() => { window.JSZip = undefined; });
  await page.route('**/js/jszip.min.js', route => route.fulfill({ status: 404 }));
  const library = await readFile('node_modules/jszip/dist/jszip.min.js');
  let loaded = false;
  await page.route('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', async route => {
    loaded = true;
    await route.fulfill({ body: library, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  expect(loaded).toBe(true);
  expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
});

test('very long Unicode content keeps valid XML and bounded section bytes', async ({ page }) => {
  await mockWikipedia(page, `<div class="mw-parser-output"><p>${'日本語🌍 &amp; '.repeat(12000)}</p></div>`);
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  for (const name of Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name))) {
    const text = await zip.file(name)!.async('string');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(26000);
    expect(text).not.toContain('\ufffd');
  }
});

test('large article lists retain their list containers and numbering', async ({ page }) => {
  const items = Array.from({ length: 200 }, (_, index) => `<li id="ref${index}">${'Reference details. '.repeat(30)}</li>`).join('');
  await mockWikipedia(page, `<div class="mw-parser-output"><p>An article with many references and a long bibliography, split across several sections.</p><h2 id="History">History</h2><ol>${items}</ol></div>`);
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const sections = await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')));
  const lists = await page.evaluate(texts => texts.map(text => {
    const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    return { invalid: [...doc.querySelectorAll('li')].filter(li => !['ol', 'ul'].includes(li.parentElement!.localName)).length, starts: [...doc.querySelectorAll('ol[start]')].map(list => Number(list.getAttribute('start'))) };
  }), sections);
  expect(lists.every(list => list.invalid === 0)).toBe(true);
  expect(lists.flatMap(list => list.starts).some(start => start > 1)).toBe(true);
});


test('WWII infobox stacks explicit facts after the opening paragraph and removes reading clutter', async ({ page }) => {
  await mockWikipedia(page, await readFile('tests/fixtures/world-war-ii.html', 'utf8'));
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const texts = await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')));
  const result = await page.evaluate(texts => {
    const docs = texts.map(text => new DOMParser().parseFromString(text, 'application/xhtml+xml'));
    const first = docs[0];
    return {
      firstBlock: first.querySelector('body')!.children[1].textContent,
      facts: [...first.querySelectorAll('.wp-fact')].map(fact => fact.textContent),
      labels: [...first.querySelectorAll('.wp-fact > p > strong')].map(label => ({ label: label.textContent, value: label.parentElement!.nextElementSibling!.textContent })),
      captions: [...first.querySelectorAll('figure > figcaption')].map(caption => caption.textContent),
      sharedCaption: [...first.querySelectorAll('.wp-facts ul')].find(list => list.textContent?.includes('Stuka'))?.textContent,
      sharedItems: [...(Array.from(first.querySelectorAll('.wp-facts ul')).find(list => list.textContent?.includes('Stuka'))?.children || [])].map(item => item.textContent),
      tables: docs.reduce((sum, doc) => sum + doc.querySelectorAll('table').length, 0),
      links: docs.reduce((sum, doc) => sum + doc.querySelectorAll('a,nav').length, 0),
      headings: docs.flatMap(doc => [...doc.querySelectorAll('h2,h3')].map(heading => heading.textContent)),
    };
  }, texts);
  expect(result.firstBlock).toContain('World War II');
  expect(result.firstBlock).toContain('global conflict');
  expect(result.captions).toHaveLength(0);
  expect(result.sharedItems).toHaveLength(6);
  expect(result.sharedItems[0]).toContain('Stuka');
  expect(result.sharedItems[1]).toContain('Matilda II');
  expect(result.sharedItems[5]).toContain('Lingayen Gulf');
  expect(texts.join('')).toContain('From top to bottom, left to right');
  expect(result.tables).toBe(0);
  expect(result.links).toBe(0);
  expect(result.labels).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: 'Date', value: expect.stringContaining('1 September 1939') }),
    expect.objectContaining({ label: 'Location', value: expect.stringContaining('Global') }),

  ]));
  expect(result.facts.join(' ')).toContain('Joseph Stalin');
  expect(result.facts.join(' ')).toContain('Adolf Hitler');
  expect(result.labels.map(item => item.label)).not.toContain('Allies');
  expect(result.labels.map(item => item.label)).not.toContain('Axis');
  expect(result.headings).toContain('Start and end dates');
  for (const excluded of ['Contents', 'See also', 'Notes', 'References', 'Sources', 'Further reading', 'External links']) expect(result.headings).not.toContain(excluded);
  expect(texts.join('')).not.toMatch(/Main article:|Several terms|Unwanted|cite_note|\[a\]/);
  const opf = await zip.file('EPUB/content.opf')!.async('string');
  expect(opf).not.toContain('sources.xhtml');
  expect(opf).not.toContain('idref="nav"');
  expect(await zip.file('EPUB/nav.xhtml')!.async('string')).not.toMatch(/Sources|References|Contents<\/a>/);
});

test('excluded sections remove subsections and resume at the next peer heading', async ({ page }) => {
  await mockWikipedia(page, `<div class="mw-parser-output"><p>Readable introduction.</p><section><div class="mw-heading"><h2>Notes</h2></div><p>REMOVE notes</p><h3>Details</h3><p>REMOVE details</p></section><section><h2>History</h2><p>KEEP history with x<sup>2</sup> and <a href="/wiki/Test">linked words</a><sup class="reference">[9]</sup>.</p><h3>Further readings</h3><p>REMOVE books</p><h3>Aftermath</h3><p>KEEP aftermath</p></section><h2>Sources and image credits</h2><p>REMOVE credits</p></div>`);
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const texts = await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')));
  expect(texts.join('')).not.toContain('REMOVE');
  expect(texts.join('')).toContain('KEEP history');
  expect(texts.join('')).toContain('KEEP aftermath');
  expect(texts.join('')).toContain('x<sup>2</sup>');
  expect(texts.join('')).toContain('linked words');
  expect(texts.join('')).not.toContain('[9]');
});


test('legacy thumbnails preserve figure captions and explicit heading alignment', async ({ page }) => {
  await mockWikipedia(page, `<div class="mw-parser-output"><p>Introduction.</p><div class="thumb"><div class="thumbinner"><a href="/wiki/File:Maputo.jpg"><img src="https://upload.wikimedia.org/maputo.jpg" alt="Maputo skyline" /></a><div class="thumbcaption">A <a href="/wiki/Maputo">Maputo</a> caption.</div></div></div><h2>History</h2><p>History text.</p></div>`);
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const text = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(text).toContain('<figcaption>A Maputo caption.</figcaption>');
  expect(text).toMatch(/<figure(?:\s[^>]*)?>/);
  expect(await zip.file('EPUB/article.css')!.async('string')).toContain('h1,h2,h3,h4,h5,h6{text-align:left;page-break-after:avoid}');
});

test('Maputo preserves Unicode prose and excludes Bibliography from reading and navigation', async ({ page }) => {
  await mockWikipedia(page, await readFile('tests/fixtures/maputo.html', 'utf8'));
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const texts = await Promise.all(Object.keys(zip.files).filter(name => name.endsWith('.xhtml') || name.endsWith('.ncx')).map(name => zip.file(name)!.async('string')));
  const combined = texts.join('');
  expect(combined).not.toContain('Bibliography');
  expect(combined).toContain('Retained article text.');
  expect(combined).toContain('Lourenço Marques');
  expect(combined).toContain('[mɐˈputu]');
  expect(combined).toContain('ˈmaɾkɨʃ]');
  expect(combined).not.toContain('\ufffd');
});




test('pronunciation text survives while offline audio controls are removed', async ({ page }) => {
  await mockWikipedia(page, `<div class="mw-parser-output"><p>French (<i>français</i> <span class="IPA" lang="fr-Latn-fonipa">[fʁɑ̃sɛ]</span> <span class="ext-phonos"><a role="button" href="https://upload.wikimedia.org/example.mp3">Listen</a><sup class="ext-phonos-attribution">ⓘ</sup></span>) and Greek <span lang="el">ἑλληνική</span>, Russian <span lang="ru">русский</span>.</p></div>`);
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const text = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(text).toContain('[fʁɑ̃sɛ]');
  expect(text).toContain('ἑλληνική');
  expect(text).toContain('русский');
  expect(text).not.toMatch(/Listen|ⓘ|example.mp3/);
});

test('Clear empties and focuses the query without clipboard access or a search', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    get() { throw new Error('Clipboard access must not be attempted'); },
  }));
  const query = page.getByLabel('Article title or Wikipedia URL');
  await query.fill('Existing query');
  let searched = false;
  page.on('request', request => { if (request.url().includes('wikipedia.org/w/api.php')) searched = true; });
  await page.getByRole('button', { name: 'Clear article query', exact: true }).click();
  await expect(query).toHaveValue('');
  await expect(query).toBeFocused();
  expect(searched).toBe(false);
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toHaveCount(0);
  await expect(page.getByText('Touch and hold the textbox or right-click to paste.', { exact: true })).toBeVisible();
  await page.keyboard.insertText('Maputo');
  await expect(query).toHaveValue('Maputo');
});


test('focusing the query selects existing text for replacement', async ({ page, isMobile }) => {
  const query = page.getByLabel('Article title or Wikipedia URL');
  await query.fill('Existing query');
  await page.getByLabel('Wikipedia language', { exact: true }).focus();
  if (isMobile) await query.tap();
  else await query.click();
  expect(await query.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 'Existing query'.length]);
  await page.keyboard.insertText('Maputo');
  await expect(query).toHaveValue('Maputo');
  // A second tap while focused should allow normal caret placement.
  if (isMobile) await query.tap({ position: { x: 5, y: 10 } });
  else await query.click({ position: { x: 5, y: 10 } });
  const selection = await query.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]);
  expect(selection[0]).toBe(selection[1]);
});


test('periodic-table grids are omitted while ordinary data and surrounding prose survive', async ({ page }) => {
  await mockWikipedia(page, await readFile('tests/fixtures/periodic-table.html', 'utf8'));
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const texts = await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')));
  const result = await page.evaluate(texts => {
    const docs = texts.map(text => new DOMParser().parseFromString(text, 'application/xhtml+xml'));
    return {
      prose: docs.map(doc => doc.querySelector('body')!.textContent).join(' '),
      tables: docs.flatMap(doc => [...doc.querySelectorAll('table')].map(table => ({ caption: table.querySelector('caption')?.textContent, rows: table.querySelectorAll('tr').length }))),
    };
  }, texts);
  expect(result.prose.match(/A complex table was omitted from this edition\./g)).toHaveLength(1);
  expect(result.prose).not.toMatch(/Hydrogen|Helium/);
  expect(result.prose).toContain('Retained explanation after the grid.');
  expect(result.tables).toEqual([{ caption: expect.stringContaining("Bohr's electron configurations"), rows: 10 }]);
});

for (const example of [
  { name: 'nested tables', html: '<table><caption>Preserved outer caption</caption><tr><th colspan="2">DROP BODY<table><caption>Preserved inner caption</caption><tr><td>DROP BODY</td></tr></table></th></tr></table>', captions: ['Preserved outer caption', 'Preserved inner caption'] },
  { name: 'merged data cells', html: '<table><caption>Preserved caption</caption><tr><th>A</th><th>B</th></tr><tr><td rowspan="2">DROP BODY</td><td>DROP BODY</td></tr><tr><td>DROP BODY</td></tr></table>', captions: ['Preserved caption'] },
  { name: 'grouped column headers', html: '<table><tr><th colspan="4">Preserved table title</th></tr><tr><th colspan="2">DROP BODY</th><th colspan="2">DROP BODY</th></tr><tr><td>DROP BODY</td><td>DROP BODY</td><td>DROP BODY</td><td>DROP BODY</td></tr></table>', captions: ['Preserved table title'] },
  { name: 'ragged grids', html: '<table><caption>Preserved caption</caption><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr><tr><td>DROP BODY</td><td>DROP BODY</td></tr></table>', captions: ['Preserved caption'] },
  { name: 'wide grids without headers', html: '<table><caption>Preserved caption</caption><tr><td>DROP BODY</td><td>DROP BODY</td><td>DROP BODY</td><td>DROP BODY</td></tr></table>', captions: ['Preserved caption'] },
]) {
  test(`complex table fallback handles ${example.name} without interpreting cell content`, async ({ page }) => {
    await mockWikipedia(page, `<div class="mw-parser-output"><p>Keep the introduction.</p>${example.html}<p>Keep the explanation.</p></div>`);
    await selectArticle(page);
    await page.getByLabel('Include optimized images').uncheck();
    const { zip } = await download(page);
    const text = await zip.file('EPUB/section-1.xhtml')!.async('string');
    expect(text.match(/A complex table was omitted from this edition\./g)).toHaveLength(1);
    for (const caption of example.captions) expect(text).toContain(caption);
    expect(text).not.toContain('DROP BODY');
    expect(text).not.toContain('<table');
    expect(text).toContain('Keep the introduction.');
    expect(text).toContain('Keep the explanation.');
  });
}

test('a spanning title above simple column headers still produces labeled rows', async ({ page }) => {
  await mockWikipedia(page, '<div class="mw-parser-output"><p>Introduction.</p><table><caption>Survey caption</caption><tr><th colspan="4">Survey title</th></tr><tr><th>Year</th><th>City</th><th>Region</th><th>Country</th></tr><tr><td>2020</td><td>City value</td><td>Region value</td><td>Country value</td></tr></table></div>');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const text = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(text).toContain('Survey title');
  expect(text).toContain('Survey caption');
  expect(text).toContain('Year: ');
  expect(text).toContain('City value');
  expect(text).not.toContain('omitted');
});

test('complex nested tables inside infoboxes do not remove ordinary key facts', async ({ page }) => {
  await mockWikipedia(page, '<div class="mw-parser-output"><p>Introduction.</p><table class="infobox"><tr><th>Date</th><td>1999</td></tr><tr><td colspan="2"><table><caption>Nested diagram</caption><tr><td colspan="4">DROP BODY</td></tr></table></td></tr></table></div>');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const text = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(text).toContain('wp-facts');
  expect(text).toContain('Date');
  expect(text).toContain('1999');
  expect(text).toContain('Nested diagram');
  expect(text.match(/A complex table was omitted from this edition\./g)).toHaveLength(1);
  expect(text).not.toContain('DROP BODY');
});


test('Wikipedia indentation lists become valid blocks while definitions remain lists', async ({ page }) => {
  await mockWikipedia(page, '<div class="mw-parser-output"><p>Introduction.</p><dl><dd>2, 8, 8, 18, 18, 32, 32, ...</dd><dd><dl><dd>Nested indentation</dd></dl></dd></dl><dl><dt>Orbital</dt><dd>A definition.</dd></dl><dl dir="rtl"><dt>Notes</dt></dl><ul><li>A local explanation.</li></ul></div>');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const text = await zip.file('EPUB/section-1.xhtml')!.async('string');
  const result = await page.evaluate(text => {
    const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    return { indents: doc.querySelectorAll('blockquote').length, definitions: [...doc.querySelectorAll('dl')].map(list => list.textContent), invalid: doc.querySelectorAll('dl > dd:first-child,blockquote > dd').length };
  }, text);
  expect(result.indents).toBe(2);
  expect(result.definitions).toEqual(['OrbitalA definition.']);
  expect(result.invalid).toBe(0);
  expect(text).toContain('2, 8, 8, 18, 18, 32, 32, ...');
  expect(text).toContain('Nested indentation');
  expect(text).toContain('<strong>Notes</strong>');
  expect(text).toContain('dir="rtl"');
});

test('standard galleries stack figures with their own captions and omit audio-only entries', async ({ page }) => {
  const gallery = await readFile('tests/fixtures/galleries.html', 'utf8');
  await mockWikipedia(page, gallery.replace(/<\/div>\s*$/, '') + `<figure><video src="clip.webm"></video><figcaption>REMOVE video caption</figcaption></figure><p>KEEP pronunciation /mɐˈputu/ and prose about recordings.</p></div>`);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 900;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.route('https://upload.wikimedia.org/**', route => route.fulfill({ body: Buffer.from(png, 'base64'), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await selectArticle(page);
  const { zip } = await download(page);
  const xml = (await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')))).join('');
  const result = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xhtml+xml');
    return {
      figures: [...doc.querySelectorAll('figure')].map(figure => ({ caption: figure.querySelector('figcaption')?.textContent?.trim(), images: figure.querySelectorAll('img').length })),
      lists: doc.querySelectorAll('ul,li,audio,video').length,
      text: doc.documentElement.textContent,
    };
  }, xml);
  expect(result.figures).toHaveLength(2);
  expect(result.figures.every(figure => figure.images === 1 && figure.caption)).toBe(true);
  expect(result.figures[0].caption).toContain('Mansion');
  expect(result.lists).toBe(0);
  expect(result.text).not.toContain('An example');
  expect(result.text).not.toContain('REMOVE');
  expect(result.text).toContain('KEEP pronunciation /mɐˈputu/');
  expect(await zip.file('EPUB/content.opf')!.async('string')).toContain('Example photographer');
  expect(Object.keys(zip.files).filter(name => /images\/.*\.jpg$/.test(name))).toHaveLength(2);
});

test('standard navigation chrome and citation appendix aliases disappear without filtering substantive sections', async ({ page }) => {
  const chrome = ['navbar', 'sidebar', 'portalbox', 'portal-bar', 'portalborder', 'authority-control', 'sistersitebox', 'hatnote', 'dablink', 'rellink'];
  const excluded = ['Works cited', 'Endnotes', 'Notes and references', 'References &amp; sources', 'Bibliography and further reading'];
  await mockWikipedia(page, `<div class="mw-parser-output"><p>KEEP introduction.</p>${chrome.map(name => `<div class="${name}">REMOVE ${name}</div>`).join('')}
    <h2>Works</h2><p>KEEP works.</p><h2>Publications</h2><p>KEEP publications.</p><h2>Filmography</h2><p>KEEP films.</p><h2>Sources of light</h2><p>KEEP science. See the article for more discussion.</p><div class="mw-collapsible">KEEP substantive collapsible content.</div>
    ${excluded.map((name, i) => `<section><div class="mw-heading"><h2>${name}</h2></div><p>REMOVE appendix ${i}</p><h3>Subsection</h3><p>REMOVE nested</p></section><h2>Body ${i}</h2><p>KEEP body ${i}</p>`).join('')}
    <figure><audio></audio><figcaption>REMOVE recording caption</figcaption></figure>
    <figure><img src="https://upload.wikimedia.org/wikipedia/commons/example.jpg" width="100" height="100" alt="KEEP mixed image"/><audio></audio><figcaption>KEEP mixed caption</figcaption></figure>
    </div>`);
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const xml = (await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')))).join('');
  expect(xml).not.toContain('REMOVE');
  for (const text of ['works', 'publications', 'films', 'science', 'substantive collapsible content', 'body 4', 'mixed caption']) expect(xml).toContain(`KEEP ${text}`);
  expect(xml).toContain('See the article for more discussion.');
});

test('infoboxes use explicit headers and wide tables put each labeled field on its own line', async ({ page }) => {
  await mockWikipedia(page, `<div class="mw-parser-output"><p>Introduction.</p>
    <table class="infobox"><tr><td>Short A</td><td>Short B</td></tr><tr><td>Unlabeled one</td><td>Unlabeled two</td></tr>
      <tr><th>North</th><th>South</th></tr><tr><th>Mass</th><td>10 kg</td><td>20 kg</td></tr>
      <tr><th colspan="2">New subsection</th></tr><tr><td>After one</td><td>After two</td></tr></table>
    <table><tr><th>Name</th><th>Area</th><th>People</th><th>Year</th></tr><tr><td>Example</td><td>12</td><td>34</td><td>2024</td></tr><tr><td>Other</td><td>56</td><td>78</td><td>2025</td></tr></table></div>`);
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const xml = await zip.file('EPUB/section-1.xhtml')!.async('string');
  const result = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xhtml+xml');
    return { labels: [...doc.querySelectorAll('.wp-fact > p')].map(el => el.textContent), fields: [...doc.querySelectorAll('.wp-table-row')].map(row => [...row.children].map(field => field.textContent)), facts: [...doc.querySelectorAll('.wp-fact')].map(el => el.textContent) };
  }, xml);
  expect(result.labels).toEqual(['Mass — North', 'Mass — South']);
  expect(result.facts).toContain('Unlabeled one');
  expect(result.facts).toContain('After two');
  expect(result.fields).toEqual([['Name: Example', 'Area: 12', 'People: 34', 'Year: 2024'], ['Name: Other', 'Area: 56', 'People: 78', 'Year: 2025']]);
  expect(xml).not.toContain(' · ');
});

test('spatial diagrams have explicit omission notices and preserve their captions and surrounding prose', async ({ page }) => {
  await mockWikipedia(page, `<p>Chess positions and family relationships depend on spatial layout.</p>
    <div class="chessboard thumb"><div class="center">Moves of the rook</div><div class="thumbinner"><table><tr><td colspan="8"><img alt="a8 black rook" width="26" height="26" src="https://upload.wikimedia.org/rook.png"></td></tr></table><div class="thumbcaption">An opening position.</div></div></div>
    <h2>Family tree</h2><table class="tree-chart"><caption>A royal genealogy.</caption><tr><td colspan="6"><a href="/wiki/James">James</a></td><td></td><td>Anne</td></tr></table><p>The family history continues.</p>`);
  await selectArticle(page);
  const { zip } = await download(page);
  const xml = (await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')))).join('');
  expect(xml).toContain('A chessboard diagram was omitted from this edition.');
  expect(xml).toContain('A family tree diagram was omitted from this edition.');
  expect(xml).toContain('An opening position.');
  expect(xml).toContain('Moves of the rook');
  expect(xml).toContain('A royal genealogy.');
  expect(xml).toContain('The family history continues.');
  expect(xml).not.toMatch(/a8 black rook|James|Anne|<table|<img/);
});

test('unavailable equations get notices and long code wraps inside the narrow reader page', async ({ page }) => {
  await mockWikipedia(page, `<p>Technical notation should remain inside the page rather than being cut off.</p><p><span class="mwe-math-element"><math alttext="${'x'.repeat(200)}"></math></span></p><pre><code>${'some_long_identifier_'.repeat(30)}</code></pre><table><tr><th>Pattern</th><th>Description</th><th>Example</th></tr><tr><th>.*</th><td>A greedy pattern.</td><td><pre><span>${'long_syntax_token_'.repeat(40)}</span></pre></td></tr></table><h2>Explanatory notes</h2><p>REMOVED APPENDIX</p>`);
  await selectArticle(page);
  const { zip } = await download(page);
  const text = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(text).not.toContain('REMOVED APPENDIX');
  expect(text).toContain('Equation omitted');
  expect(text).not.toContain('x'.repeat(200));
  expect(text).toContain('Example: ');
  expect(text).not.toContain('<table');
  const css = await zip.file('EPUB/article.css')!.async('string');
  const preview = await page.context().newPage();
  await preview.setViewportSize({ width: 480, height: 800 });
  await preview.setContent(text.replace(/<link[^>]+>/, `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style>`));
  expect(await preview.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480);
  await preview.close();
});

test('hidden template text stays hidden after styles are removed and math alternatives survive', async ({ page }) => {
  await mockWikipedia(page, `<p>The visible article introduction has enough words to appear in the preview.</p><p>Visible <span style="display:none!important">HIDDEN SORT KEY</span><span hidden>HIDDEN DUPLICATE</span><span style="visibility:hidden">HIDDEN SPACER</span> prose.</p><p><span class="mwe-math-element"><span style="display:none"><math alttext="x squared"><msup><mi>x</mi><mn>2</mn></msup></math></span><img alt="x squared" src="https://upload.wikimedia.org/equation.png"></span></p>`);
  await selectArticle(page);
  const { zip } = await download(page);
  const xml = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(xml).not.toContain('HIDDEN');
  expect(xml).toContain('Visible  prose.');
  expect(xml).toContain('<i>x</i><sup><span>2</span></sup>');
});

test('interactive maps omit the entire overlay and preserve nearby map captions and prose', async ({ page }) => {
  await mockWikipedia(page, `<p>Maps use positioned labels that cannot be interpreted as ordinary article text.</p><div class="thumb"><div class="thumbinner"><div class="mw-kartographer-container"><a class="mw-kartographer-map mw-kartographer-container"><img src="https://maps.wikimedia.org/map.png" alt="Map"></a><div style="position:absolute">ORPHAN MAP LABEL</div></div><div class="thumbcaption">Location of the mountain.</div></div></div><p>Mountains surround the valley.</p>`);
  await selectArticle(page);
  const { zip } = await download(page);
  const xml = await zip.file('EPUB/section-1.xhtml')!.async('string');
  expect(xml.split('A map was omitted from this edition.')).toHaveLength(2);
  expect(xml).toContain('Location of the mountain.');
  expect(xml).toContain('Mountains surround the valley.');
  expect(xml).not.toMatch(/ORPHAN MAP LABEL|<img/);
});

test('every infobox followed by prose retains a separating line break in the EPUB', async ({ page }) => {
  await mockWikipedia(page, `<p>A general article introduction.</p>
    <table class="infobox"><tr><th>First facts</th><td>First value</td></tr></table><p>Prose after first infobox.</p>
    <table class="infobox"><tr><th>Other facts</th><td>Other value</td></tr></table><p>Prose after other infobox.</p>
    <table><tr><td>Ordinary table</td></tr></table><p>Prose after ordinary table.</p>`);
  await selectArticle(page);
  const { zip } = await download(page);
  const xml = await zip.file('EPUB/section-1.xhtml')!.async('string');
  const result = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xhtml+xml');
    return [...doc.querySelectorAll('p')].filter(p => p.textContent?.startsWith('Prose after')).map(p => ({ text: p.textContent, leadingBreak: p.firstElementChild?.tagName.toLowerCase() === 'br' }));
  }, xml);
  expect(result).toEqual([
    { text: 'Prose after first infobox.', leadingBreak: true },
    { text: 'Prose after other infobox.', leadingBreak: true },
    { text: 'Prose after ordinary table.', leadingBreak: false },
  ]);
});
