import JSZip from 'jszip';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const payload = 'wikipedia.crosspoint-plugin';
const manifest = JSON.parse(await readFile(`${payload}/manifest.json`, 'utf8'));
const zip = new JSZip();
for (const file of manifest.files) zip.file(`${manifest.name}/${file}`, await readFile(`${payload}/${file}`), { createFolders: false });
await mkdir('dist', { recursive: true });
const filename = `dist/${manifest.name}.crosspoint-plugin.zip`;
await writeFile(filename, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Packaged ${filename}: extract into /plugins on the SD card`);
