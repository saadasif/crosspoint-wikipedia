import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const run = promisify(execFile);
const version = '5.4.0';
const cache = path.resolve(`.context/epubcheck-${version}`);
let jar = process.env.EPUBCHECK_JAR || path.join(cache, `epubcheck-${version}`, 'epubcheck.jar');
try { await stat(jar); }
catch {
  if (process.env.EPUBCHECK_JAR) throw new Error(`EPUBCHECK_JAR does not exist: ${jar}`);
  console.log(`Downloading W3C EPUBCheck ${version} (development tool only)…`);
  const response = await fetch(`https://github.com/w3c/epubcheck/releases/download/v${version}/epubcheck-${version}.zip`);
  if (!response.ok) throw new Error(`EPUBCheck download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== '33350c61038e71dfb3d45a76aed04bf5481e6d5500cb780f6e98db8bbd15a28c') throw new Error('EPUBCheck checksum mismatch');
  const zip = await JSZip.loadAsync(bytes);
  for (const file of Object.values(zip.files)) {
    if (file.dir || !file.name.endsWith('.jar')) continue;
    const destination = path.resolve(cache, file.name);
    if (!destination.startsWith(cache + path.sep)) throw new Error('Unsafe EPUBCheck archive path');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await file.async('nodebuffer'));
  }
}

async function epubs(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await epubs(filename));
    else if (entry.name.endsWith('.epub')) files.push(filename);
  }
  return files;
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : await epubs('test-results');
if (!files.length) throw new Error('No EPUBs found. Run npm test first, or pass EPUB filenames.');
let next = 0;
const failures = [];
await Promise.all(Array.from({ length: Math.min(2, files.length) }, async () => {
  while (next < files.length) {
    const filename = files[next++];
    try {
      await run(process.env.EPUBCHECK_JAVA || 'java', ['-jar', jar, filename], { maxBuffer: 1024 * 1024 });
      console.log(`EPUBCheck passed: ${filename}`);
    } catch (error) {
      failures.push(filename);
      console.error(filename, (error.stderr || error.message).slice(0, 2400));
    }
  }
}));
console.log(`${files.length - failures.length}/${files.length} EPUBs passed EPUBCheck ${version}`);
if (failures.length) process.exitCode = 1;
