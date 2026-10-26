import { build } from 'esbuild';
import { copyFile, readFile, stat } from 'node:fs/promises';

const payload = 'wikipedia.crosspoint-plugin';
const manifest = JSON.parse(await readFile(`${payload}/manifest.json`, 'utf8'));
await build({
  entryPoints: ['src/plugin.ts'], outfile: `${payload}/plugin.js`, bundle: true,
  format: 'iife', target: ['es2020'], minify: true, legalComments: 'none',
  banner: { js: `/*! CrossPoint Wikipedia ${manifest.version} | MIT | github.com/saadasif/crosspoint-wikipedia */` },
});
for (const name of ['epub', 'equations', 'fonts', 'transfer']) {
  await build({
    entryPoints: [`src/${name}.ts`], outfile: `${payload}/${name}.js`, bundle: true,
    format: 'esm', target: ['es2020'], minify: true, legalComments: 'none',
  });
}
await copyFile('node_modules/mathjax-full/LICENSE', `${payload}/MathJax-LICENSE.txt`);
await copyFile('LICENSE', `${payload}/LICENSE`);
const { size } = await stat(`${payload}/plugin.js`);
if (size > 30000) throw new Error(`Plugin exceeds 30 KB budget: ${size} bytes`);
console.log(`Built plugin.js: ${size.toLocaleString()} bytes / 30,000 byte budget`);
