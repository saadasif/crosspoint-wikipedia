import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import JSZip from 'jszip';
import { mockWikipedia, selectArticle } from './fixtures';

async function setup(page: Page): Promise<void> {
  await mockWikipedia(page, '<p>Article content for offline reading.</p>');
  await page.route('https://*.wikipedia.org/w/api.php?**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.searchParams.get('action') !== 'parse') return route.fallback();
    const title = url.searchParams.get('page');
    const mars = title === 'Mars' || url.searchParams.get('oldid') === '202';
    const headers = { 'Access-Control-Allow-Origin': '*' };
    await route.fulfill({ headers, json: title === 'Missing'
      ? { error: { info: 'Article not found. Check the title.' } }
      : { parse: { title: mars ? 'Mars' : 'Maputo', pageid: mars ? 2 : 1, revid: mars ? 202 : 101, ...(url.searchParams.get('prop')?.split('|').includes('text') ? { text: '<p>Article content for offline reading.</p>' } : {}) } } });
  });
  await page.goto('/files');
  await page.getByRole('button', { name: 'Add multiple articles', exact: true }).click();
}
async function review(page: Page, text: string): Promise<void> {
  await page.getByLabel('Articles', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Review articles', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/articles? reviewed\./);
}

test('review resolves redirects, languages and duplicates, requires invalid entries to be removed', async ({ page }, testInfo) => {
  await setup(page);
  await review(page, 'Maputo\nhttps://en.wikipedia.org/wiki/Lourenço_Marques\nMissing\nhttps://fr.wikipedia.org/wiki/Mars');
  const rows = page.locator('.wp-batch-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('Mars (fr)');
  await expect(page.getByRole('status')).toContainText('1 duplicate entries removed');
  await expect(page.getByRole('button', { name: 'Add 2 articles to reader' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove Missing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add 2 articles to reader' })).toBeEnabled();
  await mkdir('.context', { recursive: true });
  await page.screenshot({ path: `.context/batch-review-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Articles', { exact: true }).fill('Mars');
  await expect(page.getByRole('button', { name: /Add \d+ articles? to reader/ })).toBeHidden();
});

test('imports sequential EPUBs, continues after failure and retries only failed articles', async ({ page }, testInfo) => {
  const started: string[] = [];
  const contentRequests: string[] = [];
  const siteRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' || !url.hostname.endsWith('.wikipedia.org')) return;
    if (url.searchParams.get('prop')?.split('|').includes('text')) contentRequests.push(request.url());
    if (url.searchParams.get('meta') === 'siteinfo') siteRequests.push(request.url());
  });
  let failMars = true;
  await page.routeWebSocket('ws://127.0.0.1:4174/', socket => {
    let filename = '';
    let size = 0;
    const chunks: Buffer[] = [];
    socket.onMessage(async data => {
      if (typeof data === 'string') {
        const parts = data.split(':');
        filename = parts[1]; size = Number(parts[2]); started.push(filename);
        if (filename.startsWith('Mars') && failMars) { socket.send('ERROR:Reader temporarily unavailable'); return; }
        socket.send('READY');
      } else {
        chunks.push(data);
        if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) === size) {
          const bytes = Buffer.concat(chunks);
          const zip = await JSZip.loadAsync(bytes);
          expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
          const { writeFile } = await import('node:fs/promises');
          await writeFile(testInfo.outputPath(filename), bytes);
          socket.send('DONE');
        }
      }
    });
  });
  await setup(page);
  await review(page, 'Mars\nMaputo');
  expect(contentRequests).toHaveLength(0);
  expect(siteRequests).toHaveLength(0);
  await page.getByLabel('Include optimized images').uncheck();
  await page.getByRole('button', { name: 'Add 2 articles to reader' }).click();
  await expect(page.getByRole('status')).toContainText('1 article saved to /Wikipedia. 1 failed.');
  await expect(page.locator('.wp-batch-row').first()).toContainText('Reader temporarily unavailable');
  expect(started).toEqual(['Mars [en-2].epub', 'Maputo [en-1].epub']);
  // Re-review must retain both the saved outcome and the failed retry target.
  await page.getByRole('button', { name: 'Review articles', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('2 articles reviewed.');
  await expect(page.locator('.wp-batch-row').nth(1)).toContainText('Saved.');
  await expect(page.getByRole('button', { name: 'Retry failed (1)' })).toBeVisible();
  failMars = false;
  await page.getByRole('button', { name: 'Retry failed (1)' }).click();
  await expect(page.getByRole('status')).toContainText('2 articles saved');
  expect(started).toEqual(['Mars [en-2].epub', 'Maputo [en-1].epub', 'Mars [en-2].epub']);
  expect(contentRequests).toHaveLength(3);
  expect(siteRequests).toHaveLength(3);
  expect(contentRequests.every(url => new URL(url).searchParams.has('oldid'))).toBe(true);
  await page.getByRole('button', { name: 'Review articles', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('2 articles reviewed.');
  await expect(page.locator('.wp-batch-row').filter({ hasText: 'Saved.' })).toHaveCount(2);
  await expect(page.locator('.wp-save-batch')).toBeHidden();
  // Editing and using a redirect alias must not lose the saved page identity.
  await review(page, 'https://en.wikipedia.org/wiki/Lourenço_Marques');
  await expect(page.locator('.wp-batch-row')).toContainText('Saved.');
  await expect(page.locator('.wp-save-batch')).toBeHidden();
});

test('cancellation keeps saved articles and allows remaining articles to resume', async ({ page }) => {
  const started: string[] = [];
  let pause = true;
  await page.routeWebSocket('ws://127.0.0.1:4174/', socket => {
    let remaining = 0;
    let filename = '';
    socket.onMessage(data => {
      if (typeof data === 'string') {
        const parts = data.split(':'); filename = parts[1]; remaining = Number(parts[2]);
        started.push(filename); socket.send('READY');
      } else {
        remaining -= data.length;
        if (remaining === 0 && !(pause && filename.startsWith('Mars'))) socket.send('DONE');
      }
    });
  });
  await setup(page);
  await review(page, 'Maputo\nMars');
  await page.getByLabel('Include optimized images').uncheck();
  await page.getByRole('button', { name: 'Add 2 articles to reader' }).click();
  await expect(page.getByRole('status')).toContainText('Saving 2 of 2 — Mars');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled.');
  await expect(page.locator('.wp-batch-row').first()).toContainText('Saved.');
  await expect(page.locator('.wp-batch-row').nth(1)).toContainText('Ready to retry.');
  pause = false;
  await page.getByRole('button', { name: 'Add 1 article to reader' }).click();
  await expect(page.getByRole('status')).toContainText('2 articles saved');
  expect(started.filter(name => name.startsWith('Maputo'))).toHaveLength(1);
});

test('switching modes retains single preview and shared options; oversized lists are rejected', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: 'Back to single article' }).click();
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  await page.getByRole('button', { name: 'Add multiple articles', exact: true }).click();
  await review(page, 'Maputo');
  await expect(page.getByLabel('Include optimized images')).not.toBeChecked();
  await page.getByRole('button', { name: 'Back to single article' }).click();
  await expect(page.getByRole('heading', { name: 'Maputo', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download EPUB' })).toBeVisible();
  await page.getByRole('button', { name: 'Add multiple articles', exact: true }).click();
  await page.getByLabel('Articles', { exact: true }).fill(Array(26).fill('Mars').join('\n'));
  await page.getByRole('button', { name: 'Review articles', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('between 1 and 25');
  await expect(page.getByRole('button', { name: /Add \d+ articles? to reader/ })).toBeHidden();
});


test('keyboard removal preserves neighbouring rows and moves focus predictably', async ({ page }) => {
  await setup(page);
  await review(page, 'Maputo\nMars\nMissing');
  const mars = page.getByRole('button', { name: 'Remove Mars', exact: true });
  const originalMars = await mars.elementHandle();
  await page.getByRole('button', { name: 'Remove Maputo', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(mars).toBeFocused();
  expect(await originalMars!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole('button', { name: 'Remove Missing', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(mars).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Review articles', exact: true })).toBeFocused();
});

test('review cancellation restores controls without enabling an incomplete import', async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('https://*.wikipedia.org/w/api.php?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('action') !== 'parse' || url.searchParams.get('page') !== 'Mars') return route.fallback();
    await pending;
    await route.abort();
  });
  await page.getByLabel('Articles', { exact: true }).fill('Maputo\nMars');
  await page.getByRole('button', { name: 'Review articles', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Reviewing 2 of 2');
  await expect(page.getByLabel('Articles', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove Maputo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled.');
  await expect(page.getByLabel('Articles', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Remove Maputo', exact: true })).toBeDisabled();
  await expect(page.locator('.wp-save-batch')).toBeHidden();
  release();
});
