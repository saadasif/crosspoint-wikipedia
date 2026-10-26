import http from 'node:http';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

const host = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wikipedia plugin preview</title><style>
body{font:16px system-ui,sans-serif;background:#f5f5f4;color:#242424;margin:0}header{padding:20px;background:#242424;color:white}main{max-width:760px;margin:24px auto;padding:0 16px}.card{background:white;border:1px solid #ddd;border-radius:10px;padding:24px}input,button{font:inherit;border:1px solid #bbb;border-radius:5px;padding:8px}button{background:#eee}a{color:#1769aa}button:disabled{opacity:.5}h2{margin-top:0}
</style><script src="/js/jszip.min.js"></script></head><body><header>CrossPoint · File Manager preview</header><main><div id="plugin-container"><div class="card" id="wikipedia"></div></div><p>Local simulator. Use Download EPUB to inspect an article; reader uploads require hardware.</p></main><script>window.CrossPoint={registerPlugin:fn=>fn(document.getElementById('wikipedia'),{pluginFile:f=>'/plugin?name=wikipedia&file='+encodeURIComponent(f)})}</script><script src="/plugin?name=wikipedia&file=plugin.js"></script></body></html>`;

const runtimeFiles = new Set(JSON.parse(await readFile('wikipedia.crosspoint-plugin/manifest.json', 'utf8')).files);
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/files') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(host);
    } else if (url.pathname === '/plugin' && runtimeFiles.has(url.searchParams.get('file'))) {
      const file = url.searchParams.get('file');
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      response.end(await readFile(`wikipedia.crosspoint-plugin/${file}`));
    } else if (url.pathname === '/js/jszip.min.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile('node_modules/jszip/dist/jszip.min.js'));
    } else if (url.pathname === '/api/files') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(url.searchParams.get('path') === '/' ? [{ name: 'Wikipedia', isDirectory: true }] : []));
    } else if (url.pathname === '/api/fonts/upload' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
      const file = form.get('file');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const valid = form.get('family') === 'InterWiki' && new TextDecoder().decode(bytes.subarray(0, 6)) === 'CPFONT';
      response.statusCode = valid ? 200 : 400;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: valid, name: file.name, size: file.size }));
    } else if (url.pathname === '/upload' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
      const file = form.get('file');
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const mimetype = await zip.file('mimetype').async('string');
      if (mimetype !== 'application/epub+zip') throw new Error('Not an EPUB');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ name: file.name, size: file.size, mimetype }));
    } else {
      response.statusCode = 404;
      response.end('Not available in the local simulator.');
    }
  } catch {
    response.statusCode = 500;
    response.end('Run npm run build before starting the preview.');
  }
});
server.listen(4173, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4173/files'));
