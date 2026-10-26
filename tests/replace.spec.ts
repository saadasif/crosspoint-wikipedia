import { test, expect, type Page } from '@playwright/test';
import { mockWikipedia, selectArticle } from './fixtures';

const ORIGINAL = 'maputo [en-57044].epub';
const FINAL = 'Maputo [en-57044].epub';
const OLD = Buffer.from('original article and its saved state');

async function reader(page: Page, options: { http?: boolean; uploadFailure?: boolean; commitFailure?: boolean; rollbackFailure?: boolean; backupFailure?: boolean; cleanupFailure?: boolean } = {}) {
  const files = new Map<string, Buffer>([[ORIGINAL, OLD]]);
  const actions: string[] = [];
  const find = (name: string) => [...files.keys()].find(key => key.toLowerCase() === name.toLowerCase());
  await mockWikipedia(page);
  await page.route('**/api/files?**', route => route.fulfill({ json: new URL(route.request().url()).searchParams.get('path') === '/' ? [{ name: 'wikipedia', isDirectory: true }] : [...files.keys()].map(name => ({ name, isDirectory: false })) }));
  await page.route('**/rename', async route => {
    const body = new URLSearchParams(route.request().postData()!);
    const oldName = body.get('path')!.split('/').pop()!;
    const newName = body.get('name')!;
    actions.push(`rename:${oldName}:${newName}`);
    const key = find(oldName);
    if (!key) return route.fulfill({ status: 404 });
    if (find(newName)) return route.fulfill({ status: 409 });
    if ((options.backupFailure && newName.endsWith('.bak')) || (options.commitFailure && oldName.endsWith('.part.epub')) || (options.rollbackFailure && oldName.endsWith('.bak'))) return route.fulfill({ status: 500 });
    const bytes = files.get(key)!;
    files.delete(key);
    files.set(newName, bytes);
    return route.fulfill({ body: 'Renamed successfully' });
  });
  await page.route('**/delete', async route => {
    const body = new URLSearchParams(route.request().postData()!);
    const name = body.get('path')!.split('/').pop()!;
    actions.push(`delete:${name}`);
    expect(name).toMatch(/^wp-.+\.bak$/);
    if (options.cleanupFailure) return route.fulfill({ status: 500 });
    const key = find(name);
    if (!key) return route.fulfill({ status: 404 });
    files.delete(key);
    return route.fulfill({ body: 'All items deleted successfully' });
  });
  if (options.http) {
    await page.routeWebSocket('ws://127.0.0.1:4174/', socket => socket.close());
    await page.route('**/upload?**', async route => {
      const form = await new Response(new Uint8Array(route.request().postDataBuffer()!).buffer, { headers: { 'Content-Type': route.request().headers()['content-type'] } }).formData();
      const file = form.get('file') as File;
      actions.push(`upload:${file.name}`);
      if (find(file.name)) return route.fulfill({ status: 409, body: 'File already exists' });
      if (options.uploadFailure) return route.fulfill({ status: 500 });
      // WebKit's intercepted multipart body omits blob bytes; the transport
      // integration test separately checks real HTTP EPUB bytes in both engines.
      files.set(file.name, Buffer.from('new EPUB uploaded over HTTP'));
      return route.fulfill({ body: 'File uploaded successfully' });
    });
  } else {
    await page.routeWebSocket('ws://127.0.0.1:4174/', socket => {
      let name = '';
      let size = 0;
      const chunks: Buffer[] = [];
      socket.onMessage(message => {
        if (typeof message === 'string') {
          const match = message.match(/^START:([^:]+):(\d+):\/Wikipedia$/);
          expect(match).not.toBeNull();
          name = match![1];
          size = Number(match![2]);
          actions.push(`upload:${name}`);
          if (find(name)) { socket.send('ERROR:File already exists'); return; }
          socket.send('READY');
        } else {
          if (options.uploadFailure) { socket.close(); return; }
          chunks.push(message);
          const bytes = Buffer.concat(chunks);
          if (bytes.length === size) { files.set(name, bytes); socket.send('DONE'); }
        }
      });
    });
  }
  await page.goto('/files');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  return { files, actions };
}

for (const http of [false, true]) {
  test(`replacement stages a new file and removes the old copy over ${http ? 'HTTP' : 'WebSocket'}`, async ({ page }) => {
    const { files, actions } = await reader(page, { http });
    await expect(page.getByLabel('Replace existing article')).toBeChecked();
    await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved to /Wikipedia.');
    await expect(page.getByRole('status')).not.toContainText('cleanup failed');
    expect(actions[0]).toMatch(/^upload:wp-.+\.part\.epub$/);
    expect(actions[1]).toMatch(/^rename:maputo \[en-57044\]\.epub:wp-.+\.bak$/);
    expect(actions[2]).toMatch(/^rename:wp-.+\.part\.epub:Maputo \[en-57044\]\.epub$/);
    expect(files.get(FINAL)).not.toEqual(OLD);
    expect(actions[3]).toMatch(/^delete:wp-.+\.bak$/);
    expect(files.size).toBe(1);
    expect([...files.keys()].some(name => name.endsWith('.part.epub'))).toBe(false);
  });
}

test('failed replacement uploads never move the original', async ({ page }) => {
  const { files, actions } = await reader(page, { uploadFailure: true });
  await page.getByLabel('Replace existing article').check();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('disconnected');
  expect(files.get(ORIGINAL)).toEqual(OLD);
  expect(actions).toHaveLength(1);
});

test('failed final rename restores the original and retains the new temporary copy', async ({ page }) => {
  const { files, actions } = await reader(page, { commitFailure: true });
  await page.getByLabel('Replace existing article').check();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('original article was restored');
  expect(files.get(ORIGINAL)).toEqual(OLD);
  expect(actions[3]).toMatch(/^rename:wp-.+\.bak:maputo \[en-57044\]\.epub$/);
  expect([...files.keys()].some(name => name.endsWith('.part.epub'))).toBe(true);
});

test('rollback failure reports recovery paths and preserves both copies', async ({ page }) => {
  const { files } = await reader(page, { commitFailure: true, rollbackFailure: true });
  await page.getByLabel('Replace existing article').check();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Replacement could not be confirmed');
  await expect(page.getByRole('status')).toContainText('.bak');
  await expect(page.getByRole('status')).toContainText('.part');
  expect([...files].find(([name]) => name.endsWith('.bak'))?.[1]).toEqual(OLD);
  expect(files.size).toBe(2);
});

test('backup rename failure leaves the original untouched', async ({ page }) => {
  const { files, actions } = await reader(page, { backupFailure: true });
  await page.getByLabel('Replace existing article').check();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Replacement could not start');
  expect(files.get(ORIGINAL)).toEqual(OLD);
  expect(actions).toHaveLength(2);
});

test('an unchecked replacement option prevents all uploads and renames', async ({ page }) => {
  const { files, actions } = await reader(page);
  await page.getByLabel('Replace existing article').uncheck();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Already on the reader');
  expect(files.get(ORIGINAL)).toEqual(OLD);
  expect(actions).toEqual([]);
});


test('cancelling a replacement upload leaves the original untouched', async ({ page }) => {
  const { files, actions } = await reader(page, { http: true });
  await page.route('**/upload?**', () => { /* Keep upload pending until cancelled. */ });
  await page.getByLabel('Replace existing article').check();
  const pending = page.waitForRequest('**/upload?**');
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await pending;
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Cancelled.');
  expect(files.get(ORIGINAL)).toEqual(OLD);
  expect(actions).toEqual([]);
});


test('cleanup failure reports the leftover old copy without undoing the successful replacement', async ({ page }) => {
  const { files, actions } = await reader(page, { cleanupFailure: true });
  await page.getByLabel('Replace existing article').check();
  await page.getByRole('button', { name: 'Add to reader', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Old-copy cleanup failed');
  await expect(page.getByRole('status')).toContainText('.bak');
  expect(files.get(FINAL)).not.toEqual(OLD);
  expect([...files].find(([name]) => name.endsWith('.bak'))?.[1]).toEqual(OLD);
  expect(actions).toHaveLength(4);
});
