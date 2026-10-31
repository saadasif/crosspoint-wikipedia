import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { epubFingerprint } from './epub-fingerprint.mjs';

async function book({ date = '2026-01-01T00:00:00Z', modified = date, prose = 'Article text', title = 'Title', name = 'section.xhtml', mimetypeCompression = 'STORE' } = {}) {
  const zip = new JSZip();
  const options = { date: new Date(date), createFolders: false };
  zip.file('mimetype', 'application/epub+zip', { ...options, compression: mimetypeCompression });
  zip.file('EPUB/content.opf', `<package><metadata><title>${title}</title><meta property="dcterms:modified">${modified}</meta></metadata></package>`, options);
  zip.file(`EPUB/${name}`, `<html><body>${prose}</body></html>`, options);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('ZIP dates and valid generated modification dates do not repeat validation', async () => {
  assert.equal(await epubFingerprint(await book()), await epubFingerprint(await book({ date: '2026-03-02T12:34:56Z' })));
});

test('different content, metadata and entry names each require validation', async () => {
  const original = await epubFingerprint(await book());
  for (const options of [{ prose: 'Different article' }, { title: 'Different title' }, { name: 'different.xhtml' }]) {
    assert.notEqual(await epubFingerprint(await book(options)), original);
  }
});

test('invalid modification timestamps remain distinct', async () => {
  const original = await epubFingerprint(await book());
  for (const modified of ['invalid', '2026-02-31T00:00:00Z']) {
    assert.notEqual(await epubFingerprint(await book({ modified })), original);
  }
});

test('compressed mimetype cannot be deduplicated against a compliant container', async () => {
  assert.notEqual(await epubFingerprint(await book()), await epubFingerprint(await book({ mimetypeCompression: 'DEFLATE' })));
});

test('corrupt entry bytes cannot be deduplicated against a valid book', async () => {
  const bytes = await book();
  const corrupt = Buffer.from(bytes);
  corrupt[bytes.indexOf('application/epub+zip')] ^= 1;
  await assert.rejects(epubFingerprint(corrupt));
});
