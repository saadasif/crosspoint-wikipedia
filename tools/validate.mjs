import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fontFaces } from './font-coverage.mjs';

const folders = (await readdir('.', { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.crosspoint-plugin'));
assert.equal(folders.length, 1, 'Exactly one installable payload is required');
const folder = folders[0].name;
const manifest = JSON.parse(await readFile(`${folder}/manifest.json`, 'utf8'));
assert.match(manifest.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.equal(folder, `${manifest.name}.crosspoint-plugin`);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.version, JSON.parse(await readFile('package.json', 'utf8')).version);
assert.equal(manifest.mount, 'files');
assert(manifest.files.includes('manifest.json') && manifest.files.includes('plugin.js'));
assert.equal(new Set(manifest.files).size, manifest.files.length);
for (const file of manifest.files) {
  assert(!file.startsWith('/') && !file.includes('\\') && !file.split('/').includes('..'));
  assert((await stat(`${folder}/${file}`)).isFile(), `Missing runtime file: ${file}`);
}
assert.deepEqual((await readdir(folder)).sort(), [...manifest.files].sort(), 'Payload contains undeclared files');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME.replace(/^v/, ''), manifest.version, 'Tag must match manifest version');
}
console.log(`Validated ${manifest.name} ${manifest.version}: Plugin Hub payload contract satisfied`);

const fontInfo = JSON.parse(await readFile('src/font-pack.json', 'utf8'));
const fontZip = await JSZip.loadAsync(await readFile(`${folder}/inter-fonts.zip`), { checkCRC32: true });
const samples = JSON.parse(await readFile('tools/font-samples.json', 'utf8'));
for (const font of fontInfo.files) {
  const bytes = await fontZip.file(`${fontInfo.family}/${font.name}`).async('uint8array');
  assert.equal(bytes.byteLength, font.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), font.sha256, `Font mismatch: ${font.name}`);
  const faces = fontFaces(bytes, font.size);
  assert.equal(faces.length, 4, `Missing styles: ${font.name}`);
  for (const face of faces) {
    for (const [language, text] of Object.entries(samples)) {
      const missing = [...new Set([...text].filter(char => !/\s/u.test(char) && !face.hasBitmap(char.codePointAt(0))))];
      assert.deepEqual(missing, [], `${face.name}: missing ${language} glyphs: ${missing.join('')}`);
    }
  }
}
const inputs = JSON.parse(await readFile('tools/font-inputs.json', 'utf8'));
for (const license of [...Object.keys(inputs.scriptLicenses), ...Object.keys(inputs.downloads).filter(name => name.endsWith('-OFL.txt')), 'NotoSans-OFL.txt']) assert(fontZip.file(`${fontInfo.family}/${license}`));
console.log('Validated bundled font checksums, licenses and multilingual glyphs in all 16 faces');
