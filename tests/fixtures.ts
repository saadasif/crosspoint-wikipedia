import { test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

export const ARTICLE = `<div class="mw-parser-output">
<script>window.articleScriptRan=true</script><div class="navbox">NAVIGATION TO REMOVE</div>
<p><b>Maputo</b> is the capital and largest city of Mozambique, with a long history on the Indian Ocean coast. Its name includes accented text: São Tomé &amp; Príncipe.</p>
<table class="infobox"><tr><th>Country</th><td>Mozambique</td></tr><tr><th><div>Coordinates</div></th><td><div>25° S</div></td></tr></table>
<p>Reference <sup><a href="#cite_note-1">[1]</a></sup> and a <a href="javascript:alert(1)">bad link</a>.</p>
<figure><a href="/wiki/File:Maputo.jpg"><img src="https://upload.wikimedia.org/wikipedia/commons/maputo.jpg" srcset="https://upload.wikimedia.org/wikipedia/commons/maputo-large.jpg 2x, https://evil.example/image.jpg 3x" width="960" height="600" alt="Maputo skyline" onerror="alert(1)"/></a><figcaption>A view across Maputo Bay.</figcaption></figure>
<div class="mw-heading mw-heading2"><h2 id="History">History</h2><span class="mw-editsection">EDIT TO REMOVE</span></div>
<p>The city's history includes trade, migration, and political change.</p>
<span>External resources<ul><li>A resource in a legacy Wikipedia template.</li></ul></span>
<b><div>Courses and lectures</div></b>
<table><caption>Population</caption><tr><th>Year</th><th>City</th><th>Region</th><th>Country</th></tr><tr><td>2020</td><td>City value</td><td>Region value</td><td>Country value</td></tr></table>
<h2 id="References">References</h2><ol><li id="cite_note-1">A cited source. <a href="#History">Back to history</a>.</li></ol>
</div>`;

export async function mockWikipedia(page: Page, html = ARTICLE): Promise<void> {
  await page.route('https://*.wikipedia.org/w/api.php?**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Api-User-Agent', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const query = url.searchParams;
    let data: unknown;
    if (query.get('action') === 'parse') {
      data = { parse: { title: query.get('page') || 'Maputo', pageid: 57044, revid: 12345, text: html } };
    } else if (query.get('list') === 'search') {
      data = { query: { search: [{ title: 'Maputo', snippet: '<b>Capital</b> of Mozambique <img src=x onerror=alert(1)>' }] } };
    } else if (query.get('prop') === 'imageinfo') {
      data = { query: { pages: [{ imageinfo: [{ extmetadata: { Artist: { value: '<a href="https://example.com">Example photographer</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' } } }] }] } };
    } else {
      data = { query: { general: { rtl: false }, rightsinfo: { text: 'Creative Commons Attribution-Share Alike 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' } } };
    }
    await route.fulfill({ json: data, headers });
  });
}

export async function selectArticle(page: Page): Promise<void> {
  await page.getByLabel('Article title or Wikipedia URL').fill('Maputo');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Maputo Capital of Mozambique' }).click();
  await page.getByRole('status').filter({ hasText: 'Ready to import.' }).waitFor();
}

export async function download(page: Page): Promise<{ zip: JSZip; bytes: Buffer; filename: string }> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download EPUB', exact: true }).click();
  const file = await pending;
  const bytes = await readFile((await file.path())!);
  await file.saveAs(test.info().outputPath('article.epub'));
  return { zip: await JSZip.loadAsync(bytes), bytes, filename: file.suggestedFilename() };
}
