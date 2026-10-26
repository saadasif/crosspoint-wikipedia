import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

const FONT: { family: string; files: { size: number; name: string; bytes: number }[] } = JSON.parse(await readFile('src/font-pack.json', 'utf8'));
type FontUpload = { ok: boolean; name: string; size: number };

async function openSetup(page: Page) {
  await page.goto('/files');
  await page.getByText('Optional reader font', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install Inter', exact: true })).toBeVisible();
}

async function uploadedFile(request: import('@playwright/test').Request) {
  const form = await new Response(new Uint8Array(request.postDataBuffer()!).buffer, { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
  expect(form.get('family')).toBe(FONT.family);
  const file = form.get('file') as File;
  // Playwright WebKit omits blob bytes from intercepted multipart requests.
  // The separate HTTP test verifies the actual upload body in both browsers.
  if (file.size) expect(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 6))).toBe('CPFONT');
  return { name: file.name, size: file.size || FONT.files.find(font => font.name === file.name)!.bytes };
}

test('font setup installs sequentially without accessing reader settings', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/files');
  expect(requests.some(url => /fonts\.js|inter-fonts\.zip|api\/fonts/.test(url))).toBe(false);
  await page.getByText('Optional reader font', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install Inter', exact: true })).toBeVisible();
  expect(requests.some(url => /inter-fonts\.zip|api\/fonts/.test(url))).toBe(false);
  await page.route('**/api/fonts', route => route.fulfill({ json: { families: [] } }));
  const uploaded: string[] = [];
  await page.route('**/api/fonts/upload', async route => {
    uploaded.push((await uploadedFile(route.request())).name);
    await route.fulfill({ json: { ok: true } });
  });
  let settingsRequests = 0;
  await page.route('**/api/settings', route => {
    settingsRequests++;
    return route.fulfill({ status: 500 });
  });
  await page.getByRole('button', { name: 'Install Inter', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Inter is installed.');
  expect(uploaded).toEqual([12, 14, 16, 18].map(size => `InterWiki_${size}.cpfont`));
  expect(settingsRequests).toBe(0);
  await expect(page.getByRole('button', { name: 'Use Inter for all books', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Settings → Reader → Font Family');
});

test('failed uploads can resume without replacing completed sizes', async ({ page }) => {
  const installed: { name: string; size: number }[] = [];
  await page.route('**/api/fonts', route => route.fulfill({ json: { families: [{ name: FONT.family, files: installed }] } }));
  let fail = true;
  const names: string[] = [];
  await page.route('**/api/fonts/upload', async route => {
    const file = await uploadedFile(route.request());
    names.push(file.name);
    if (file.name === 'InterWiki_14.cpfont' && fail) { fail = false; return route.fulfill({ status: 400, json: { error: 'Invalid font file' } }); }
    installed.push(file);
    return route.fulfill({ json: { ok: true } });
  });
  await openSetup(page);
  await page.getByRole('button', { name: 'Install Inter', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Font setup failed.');
  await page.getByRole('button', { name: 'Install Inter', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Inter is installed.');
  expect(names).toEqual(['InterWiki_12.cpfont', 'InterWiki_14.cpfont', 'InterWiki_14.cpfont', 'InterWiki_16.cpfont', 'InterWiki_18.cpfont']);
});

test('unsupported readers report a recoverable error without requesting the font pack', async ({ page }) => {
  let pack = false;
  page.on('request', request => { if (request.url().includes('inter-fonts.zip')) pack = true; });
  await page.route('**/api/fonts', route => route.fulfill({ status: 404 }));
  await openSetup(page);
  await page.getByRole('button', { name: 'Install Inter', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('firmware font support');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
  expect(pack).toBe(false);
});

test('already installed fonts skip transfer and cancellation prevents uploads', async ({ page }) => {
  await page.route('**/api/fonts', route => route.fulfill({ json: { families: [{ name: FONT.family, files: FONT.files.map(font => ({ name: font.name, size: font.bytes })) }] } }));
  let pack = false;
  let upload = false;
  await page.route('**/plugin?**', async route => {
    if (!route.request().url().includes('inter-fonts.zip')) return route.fallback();
    pack = true;
    // Keep the pack pending so the user can cancel before any writes.
  });
  await page.route('**/api/fonts/upload', async route => { upload = true; await route.fulfill({ json: { ok: true } }); });
  await openSetup(page);
  await page.getByRole('button', { name: 'Install Inter', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Inter is installed.');
  expect(pack).toBe(false);
  await page.route('**/api/fonts', route => route.fulfill({ json: { families: [] } }));
  await page.getByRole('button', { name: 'Install Inter', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preparing Inter');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled.');
  await expect(page.getByRole('button', { name: 'Install Inter', exact: true })).toBeEnabled();
  expect(upload).toBe(false);
});

test('bundled font pack covers IPA and RTL base letters, marks and joined forms in every face', async () => {
  const zip = await JSZip.loadAsync(await readFile('wikipedia.crosspoint-plugin/inter-fonts.zip'), { checkCRC32: true });
  expect(await zip.file('InterWiki/Inter-OFL.txt')!.async('string')).toContain('SIL OPEN FONT LICENSE');
  for (const license of ['NotoSansArabic-OFL.txt', 'NotoSansHebrew-OFL.txt']) {
    expect(await zip.file(`InterWiki/${license}`)!.async('string')).toContain('SIL OPEN FONT LICENSE');
  }
  for (const size of [12, 14, 16, 18]) {
    const bytes = await zip.file(`InterWiki/InterWiki_${size}.cpfont`)!.async('uint8array');
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(data.getUint16(8, true)).toBe(4);
    expect(bytes[12]).toBe(4);
    for (let style = 0; style < bytes[12]; style++) {
      const toc = 32 + style * 32;
      const count = data.getUint32(toc + 4, true);
      const offset = data.getUint32(toc + 24, true);
      // Include MiniBidi outputs: contextual forms and Lam-Alef ligatures.
      for (const character of 'ɐˈɾẽɨʃ≥≤≠̆∩⟨⟩ꞌℓ⌬⏣ᴜᴀꭓᶑ᫊⫽𝑝𐞂𝼆كأسالعالمقَطَر٢٠٢٢پچژگکیںےﭘﭼﮊﮔﮐﯽﮟﮯﺑﻴﺖﻣﺤﻤﺪﻻﻼﻷﻸשָׁלוֹםיִשְׂרָאֵל' ) {
        const cp = character.codePointAt(0)!;
        expect(Array.from({ length: count }, (_, index) => offset + index * 12).some(start => data.getUint32(start, true) <= cp && cp <= data.getUint32(start + 4, true))).toBe(true);
      }
    }
  }
});


test('font uploads deliver actual CPFONT bytes to the HTTP server', async ({ page }) => {
  await page.route('**/api/fonts', route => route.fulfill({ json: { families: [] } }));
  // Observe actual server replies inside the page without relying on the
  // browser inspector cache.
  await page.addInitScript(() => {
    const observed = window as unknown as { fontUploads: FontUpload[] };
    observed.fontUploads = [];
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await fetch(...args);
      if (new URL(response.url).pathname === '/api/fonts/upload') {
        observed.fontUploads.push(await response.clone().json());
      }
      return response;
    };
  });
  await openSetup(page);
  await page.getByRole('button', { name: 'Install Inter', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Inter is installed.');
  const uploads = await page.evaluate(() => (window as unknown as { fontUploads: FontUpload[] }).fontUploads);
  expect(uploads).toHaveLength(4);
  expect(uploads.map(file => file.size)).toEqual(FONT.files.map(font => font.bytes));
  expect(uploads.every(file => file.ok)).toBe(true);
});
