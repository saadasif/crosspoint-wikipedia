// Audit visible EPUB section text against every style and size we distribute.
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import JSZip from 'jszip';
import { fontFaces } from './font-coverage.mjs';

const files = process.argv.slice(2);
if (!files.length) throw new Error('Pass generated English EPUB filenames. Missing characters cause exit code 1.');
const pack = await JSZip.loadAsync(await readFile('wikipedia.crosspoint-plugin/inter-fonts.zip'));
const metadata = JSON.parse(await readFile('src/font-pack.json', 'utf8'));
const fonts = [];
for (const { size, name } of metadata.files) {
  const bytes = await pack.file(`${metadata.family}/${name}`).async('uint8array');
  fonts.push(...fontFaces(bytes, size));
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  let failed = false;
  const results = [];
  for (const file of files) {
    const zip = await JSZip.loadAsync(await readFile(file));
    const sections = await Promise.all(Object.keys(zip.files).filter(name => /(?:^|\/)section-\d+\.xhtml$/.test(name)).map(name => zip.file(name).async('string')));
    if (!sections.length) throw new Error(`No article sections in ${file}`);
    const prose = await page.evaluate(texts => texts.map(text => {
      const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
      if (doc.querySelector('parsererror')) throw new Error('Invalid XHTML');
      return doc.querySelector('body').textContent;
    }).join('\n'), sections);
    // Whitespace, control and formatting codepoints do not need visible glyphs.
    const characters = [...new Set([...prose].filter(char => !/[\p{Z}\p{Cc}\p{Cf}]/u.test(char)))];
    const missing = characters.flatMap(character => {
      const cp = character.codePointAt(0);
      const absent = fonts.filter(font => !font.ranges.some(([start, end]) => start <= cp && cp <= end));
      return absent.length ? [{ character, codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, missingIn: absent.length === fonts.length ? 'all 16 faces' : absent.map(font => font.name), context: prose.slice(Math.max(0, prose.indexOf(character) - 30), prose.indexOf(character) + 45).replace(/\s+/g, ' ') }] : [];
    });
    failed ||= missing.length > 0;
    results.push({ file, uniqueVisibleCharacters: characters.length, missing });
  }
  console.log(JSON.stringify(results, null, 2));
  if (failed) process.exitCode = 1;
} finally { await browser.close(); }
