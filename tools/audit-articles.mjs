// Live corpus audit: cached source revisions, actual plugin UI, EPUB contents,
// narrow-screen rendering, and both reader transfer protocols. No physical reader.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, webkit } from '@playwright/test';
import JSZip from 'jszip';

const directory = '.context/complex-articles';
const corpus = JSON.parse(await readFile('tools/audit-articles.json', 'utf8'));
await mkdir(directory, { recursive: true });
await mkdir(`${directory}/network`, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const slug = title => title.replace(/[^a-z0-9]/gi, '_');
const hash = data => createHash('sha256').update(data).digest('hex');
const images = !process.argv.includes('--no-images');
const engines = process.argv.includes('--chromium') ? { chromium } : { chromium, webkit };
const timeout = 600000;
// Include lazy components: hashing only the widget misses converter changes.
const manifest = JSON.parse(await readFile('wikipedia.crosspoint-plugin/manifest.json', 'utf8'));
async function payloadHash() {
  return hash(Buffer.concat(await Promise.all(manifest.files.filter(name => name.endsWith('.js')).map(async name =>
    Buffer.concat([Buffer.from(name + '\0'), await readFile(`wikipedia.crosspoint-plugin/${name}`)])))));
}
const bundleHash = await payloadHash();
const network = new Map();
const userAgent = 'CrossPointWikipedia-audit/0.1 (https://github.com/saadasif/crosspoint-wikipedia)';
// Reuse source snapshots; remove the cached JSONs explicitly to refresh revisions.
async function snapshot(title) {
  const file = `${directory}/${slug(title)}.json`;
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (data.parse?.revid && data.parse?.text) return data;
  } catch {}
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'parse', page: title, prop: 'text|revid', format: 'json', formatversion: '2', redirects: '1', disableeditsection: '1' });
  for (let attempt = 0; attempt < 6; attempt++) {
    await pause(attempt ? 10000 : 2500);
    const response = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': userAgent } });
    if (response.status === 429 || response.status >= 500) continue;
    assert(response.ok, `${title}: HTTP ${response.status}`);
    const data = await response.json();
    assert(data.parse?.revid && data.parse?.text, `${title}: missing article`);
    await writeFile(file, JSON.stringify(data));
    return data;
  }
  throw new Error(`${title}: Wikipedia remained unavailable after retries`);
}
for (const item of corpus) item.data = await snapshot(item.title);
let server;
try { await fetch('http://127.0.0.1:4173/files'); }
catch {
  server = spawn(process.execPath, ['tools/dev-server.mjs'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 50; attempt++) {
    await pause(100);
    try { await fetch('http://127.0.0.1:4173/files'); break; } catch {}
  }
}
async function reading(zip) {
  return Object.fromEntries(await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(async name => [name, hash(await zip.file(name).async('nodebuffer'))])));
}
const results = [];
try {
  for (const [engine, launcher] of Object.entries(engines)) {
    const browser = await launcher.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
      page.setDefaultTimeout(timeout);
      let source;
      let activeTitle = '';
      const heartbeat = setInterval(() => { void page.getByRole('status').textContent().then(status => console.error(`${engine}: ${activeTitle}: ${status}`)).catch(() => {}); }, 30000);
      browser.on('disconnected', () => clearInterval(heartbeat));
      // Relay live Wikimedia image/credit requests with CORS; cache responses for
      // the repeated export/transfer checks. Article HTML is never synthesized.
      await page.route('https://**/*', async route => {
        const url = new URL(route.request().url());
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Api-User-Agent' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (url.hostname === 'en.wikipedia.org' && url.pathname === '/w/api.php') {
          if (url.searchParams.get('action') === 'parse') return route.fulfill({ json: source, headers });
          if (url.searchParams.get('meta') === 'siteinfo') return route.fulfill({ headers, json: { query: { general: { rtl: false }, rightsinfo: { text: 'Creative Commons Attribution-Share Alike 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' } } } });
        }
        if (!network.has(url.href)) network.set(url.href, (async () => {
          const file = `${directory}/network/${hash(url.href)}.json`;
          try {
            const cached = JSON.parse(await readFile(file, 'utf8'));
            return { ...cached, body: Buffer.from(cached.body, 'base64') };
          } catch {}
          let response;
          for (let attempt = 0; attempt < 3; attempt++) {
            await pause(attempt ? 2000 : 350);
            response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': userAgent } });
            if (response.status !== 429 && response.status < 500) break;
          }
          const result = { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: { ...headers, 'Content-Type': response.headers.get('content-type') || 'application/octet-stream' } };
          if (response.ok) await writeFile(file, JSON.stringify({ ...result, body: result.body.toString('base64') }));
          return result;
        })().catch(() => ({ status: 504, body: '', headers })));
        await route.fulfill(await network.get(url.href));
      });
      let socketBytes;
      let http = false;
      await page.routeWebSocket('ws://127.0.0.1:4174/', socket => {
        if (http) return socket.close();
        const chunks = [];
        let size;
        socket.onMessage(message => {
          if (typeof message === 'string') {
            const match = message.match(/^START:([^:]+):(\d+):\/Wikipedia$/);
            assert(match, 'Reader protocol START frame');
            size = Number(match[2]);
            socket.send('READY');
          } else {
            chunks.push(message);
            const bytes = Buffer.concat(chunks);
            if (bytes.length === size) { socketBytes = bytes; socket.send('DONE'); }
          }
        });
      });
      for (const item of corpus) {
        activeTitle = item.title;
        console.error(`${engine}: auditing ${item.title}`);
        source = item.data;
        const stem = `${directory}/${slug(item.title)}-${engine}`;
        await page.goto('http://127.0.0.1:4173/files');
        await page.getByLabel('Article title or Wikipedia URL').fill(`https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`);
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'Ready to import.' }).waitFor();
        if (!images) await page.getByLabel('Include optimized images').uncheck();
        const pending = page.waitForEvent('download', { timeout });
        await page.getByRole('button', { name: 'Download EPUB', exact: true }).click();
        const file = await pending;
        await file.saveAs(`${stem}.epub`);
        console.error(`${engine}: downloaded ${item.title}`);
        const bytes = await readFile(`${stem}.epub`);
        const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
        const sections = await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name).async('string')));
        const css = await zip.file('EPUB/article.css').async('string');
        const metrics = await page.evaluate(({ html, sections }) => {
          const original = new DOMParser().parseFromString(html, 'text/html');
          const docs = sections.map(text => new DOMParser().parseFromString(text, 'application/xhtml+xml'));
          const text = docs.map(doc => doc.documentElement.textContent).join('');
          return {
            sourceTables: original.querySelectorAll('table').length,
            sourceMath: original.querySelectorAll('.mwe-math-element').length,
            sourceImages: original.querySelectorAll('img').length,
            sourceGalleries: original.querySelectorAll('.gallery').length,
            parseErrors: docs.filter(doc => doc.querySelector('parsererror')).length,
            invalidBlocks: docs.reduce((n, doc) => n + doc.querySelectorAll('p div,p p,span div,span ul,strong div').length, 0),
            tables: docs.reduce((n, doc) => n + doc.querySelectorAll('table').length, 0),
            omittedTables: text.split('A complex table was omitted').length - 1,
            omittedDiagrams: (text.match(/A (?:chessboard|family tree) diagram was omitted/g) || []).length,
            omittedMaps: text.split('A map was omitted').length - 1,
            images: docs.reduce((n, doc) => n + doc.querySelectorAll('img').length, 0),
            equations: docs.reduce((n, doc) => n + doc.querySelectorAll('img[src^="equations/"]').length, 0),
            omittedEquations: text.split('[Equation omitted:').length - 1,
            textCharacters: text.length,
            headings: docs.flatMap(doc => [...doc.querySelectorAll('h2')].map(h => h.textContent)),
            forbidden: docs.reduce((n, doc) => n + doc.querySelectorAll('script,style,a,nav,audio,video,svg,math,[data-src],[data-wp-math]').length, 0),
            maxSectionBytes: Math.max(...sections.map(text => new TextEncoder().encode(text).length)),
          };
        }, { html: source.parse.text, sections });
        assert.equal(metrics.parseErrors, 0, item.title);
        assert.equal(metrics.invalidBlocks, 0, item.title);
        assert.equal(metrics.forbidden, 0, item.title);
        assert(metrics.textCharacters > (item.title === 'Family tree of the British royal family' ? 200 : 1000), `${item.title}: missing article text`);
        if (item.title === 'Family tree of the British royal family') assert(metrics.omittedDiagrams > 0, 'Main family tree needs an explicit notice');
        if (item.title === 'Chess') assert(metrics.omittedDiagrams > 0, 'Chess boards need explicit notices');
        if (item.title === 'Adaptive immune system') assert(metrics.headings.includes('Types of acquired immunity'), 'Article must extend beyond its introduction');
        assert(metrics.maxSectionBytes < 26000, `${item.title}: oversized reader section`);
        // Check every XHTML at the reader's narrow width, with actual JPEGs.
        const imageData = {};
        for (const name of Object.keys(zip.files).filter(name => /\.(jpg|png)$/.test(name))) imageData[name.replace('EPUB/', '')] = `data:image/${name.endsWith('.png') ? 'png' : 'jpeg'};base64,${await zip.file(name).async('base64')}`;
        const preview = await browser.newPage({ viewport: { width: 480, height: 800 } });
        let overflowSections = 0;
        for (const section of sections) {
          await preview.setContent(section.replace(/<link[^>]+>/, `<style>${css}</style>`).replace(/src="((?:images|equations)\/[^"]+)"/g, (_, name) => `src="${imageData[name]}"`));
          await preview.evaluate(() => Promise.all([...document.images].map(image => image.decode().catch(() => {}))));
          assert(await preview.evaluate(() => [...document.images].every(image => image.naturalWidth > 0 && image.naturalWidth <= 448 && image.naturalHeight > 0 && image.naturalHeight <= 560)), `${item.title}: broken or oversized image`);
          if (await preview.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)) overflowSections++;
        }
        assert.equal(overflowSections, 0, `${item.title}: content exceeds reader width`);
        await preview.setContent(sections[0].replace(/<link[^>]+>/, `<style>${css}</style>`).replace(/src="((?:images|equations)\/[^"]+)"/g, (_, name) => `src="${imageData[name]}"`));
        await preview.screenshot({ path: `${stem}.png`, fullPage: false });
        await preview.close();
        socketBytes = undefined;
        http = false;
        await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'Saved to /Wikipedia.' }).waitFor();
        assert(socketBytes?.length, `${item.title}: missing socket bytes`);
        await writeFile(`${stem}-copy.epub`, socketBytes);
        assert.deepEqual(await reading(await JSZip.loadAsync(socketBytes)), await reading(zip), `${item.title}: transferred content differs from download`);
        // A second conversion can produce slightly different JPEG encodings.
        // Independently transfer the exact downloaded file and compare all bytes.
        socketBytes = undefined;
        await page.evaluate(async ({ base64, filename }) => {
          const { uploadEpub } = await import('/plugin?name=wikipedia&file=transfer.js');
          const data = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
          await uploadEpub(new File([data], filename, { type: 'application/epub+zip' }), new AbortController().signal, () => {});
        }, { base64: bytes.toString('base64'), filename: file.suggestedFilename() });
        assert(socketBytes?.equals(bytes), `${item.title}: byte-for-byte copy differs from downloaded EPUB`);
        http = true;
        const response = page.waitForResponse(response => response.url().includes('/upload?'));
        await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
        const uploaded = await (await response).json();
        await page.getByRole('status').filter({ hasText: 'Saved to /Wikipedia.' }).waitFor();
        assert.equal(uploaded.mimetype, 'application/epub+zip');
        assert.equal(uploaded.name, file.suggestedFilename());
        assert.equal(await payloadHash(), bundleHash, 'Plugin changed during the audit; rerun against a stable build');
        const result = { title: item.title, engine, revision: source.parse.revid, sourceSha256: hash(source.parse.text), bundleSha256: bundleHash, features: item.features, sections: sections.length, bytes: bytes.length, ...metrics, overflowSections, download: true, webSocketCopy: true, exactDownloadCopy: true, httpCopy: true };
        results.push(result);
        await writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2));
        console.log(JSON.stringify(result));
      }
    } finally { await browser.close(); }
  }
} finally { server?.kill(); }
assert.equal(results.length, corpus.length * Object.keys(engines).length);
console.log(`Audited ${corpus.length} articles in ${Object.keys(engines).join(', ')}. Results: ${directory}/results.json`);
