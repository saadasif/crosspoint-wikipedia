import { type Report, abortError, checkCancelled } from './types';

export const DESTINATION = '/Wikipedia';
interface Entry { name: string; isDirectory: boolean; }

export async function prepareDestination(filename: string, replace: boolean, signal: AbortSignal): Promise<string | undefined> {
  const root = await fetch('/api/files?path=%2F', { signal });
  if (!root.ok) throw new Error('Could not list the reader’s files. Keep File Transfer open.');
  const entries: Entry[] = await root.json();
  const folder = entries.find(entry => entry.name.toLowerCase() === 'wikipedia');
  if (folder && !folder.isDirectory) throw new Error('A file named Wikipedia prevents creating the article folder.');
  if (!folder) {
    const response = await fetch('/mkdir', { method: 'POST', body: new URLSearchParams({ name: 'Wikipedia', path: '/' }), signal });
    if (!response.ok) throw new Error('Could not create /Wikipedia on the reader.');
  }
  const listing = await fetch(`/api/files?path=${encodeURIComponent(DESTINATION)}`, { signal });
  if (!listing.ok) throw new Error('Could not check existing articles on the reader.');
  const files: Entry[] = await listing.json();
  const existing = files.find(entry => entry.name.toLowerCase() === filename.toLowerCase());
  if (existing?.isDirectory) throw new Error('An article folder conflicts with this filename.');
  if (!replace && existing) throw new Error('Already on the reader. Enable “Replace existing article” to update it.');
  return existing?.name;
}

class SocketUnavailable extends Error {}

function uploadSocket(file: File, signal: AbortSignal, report: Report): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = Number(location.port || 80) + 1;
    let socket: WebSocket;
    try { socket = new WebSocket(`ws://${location.hostname}:${port}/`); }
    catch { reject(new SocketUnavailable()); return; }
    let ready = false;
    let finished = false;
    let sending = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.close();
      error ? reject(error) : resolve();
    };
    const timeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(ready ? new Error('Upload timed out. Keep File Transfer open and retry.') : new SocketUnavailable()), ready ? 30000 : 5000);
    };
    const abort = () => finish(abortError());
    signal.addEventListener('abort', abort, { once: true });
    timeout();
    socket.onopen = () => { socket.send(`START:${file.name}:${file.size}:${DESTINATION}`); timeout(); };
    socket.onerror = () => finish(ready ? new Error('Reader connection lost during upload.') : new SocketUnavailable());
    socket.onclose = () => finish(ready ? new Error('Reader disconnected before confirming the upload.') : new SocketUnavailable());
    socket.onmessage = async event => {
      if (finished || typeof event.data !== 'string') return;
      timeout();
      if (event.data === 'READY' && !sending) {
        ready = true;
        sending = true;
        try {
          for (let offset = 0; offset < file.size; offset += 4096) {
            checkCancelled(signal);
            while (socket.bufferedAmount > 8192 && !finished) await new Promise(resolve => setTimeout(resolve, 5));
            if (finished || socket.readyState !== WebSocket.OPEN) return;
            const chunk = await file.slice(offset, offset + 4096).arrayBuffer();
            if (finished) return;
            socket.send(chunk);
            report('Sending to reader…', Math.min(95, Math.round((offset + chunk.byteLength) / file.size * 95)));
            timeout();
          }
        } catch (error) { finish(error instanceof Error ? error : new Error('Upload failed.')); }
      } else if (event.data === 'DONE' && ready) {
        report('Saved to /Wikipedia.', 100);
        finish();
      } else if (event.data.startsWith('ERROR:')) {
        finish(new Error(event.data.slice(6)));
      }
    };
  });
}

function uploadHttp(file: File, signal: AbortSignal, report: Report): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (error?: Error) => { signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    request.open('POST', `/upload?path=${encodeURIComponent(DESTINATION)}`);
    request.timeout = 120000;
    request.upload.onprogress = event => {
      if (event.lengthComputable) report('Sending to reader…', Math.min(95, Math.round(event.loaded / event.total * 95)));
    };
    request.onload = () => finish(request.status >= 200 && request.status < 300 ? undefined : new Error(`Reader rejected the upload (${request.status}).`));
    request.onerror = () => finish(new Error('Reader connection lost during upload.'));
    request.ontimeout = () => finish(new Error('Upload timed out. Keep File Transfer open and retry.'));
    request.onabort = () => finish(abortError());
    signal.addEventListener('abort', abort, { once: true });
    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });
}

async function transfer(file: File, signal: AbortSignal, report: Report): Promise<void> {
  checkCancelled(signal);
  try { await uploadSocket(file, signal, report); }
  catch (error) {
    checkCancelled(signal);
    if (!(error instanceof SocketUnavailable)) throw error;
    await uploadHttp(file, signal, report);
  }
}

async function fileAction(action: 'rename' | 'delete', filename: string, name?: string): Promise<void> {
  // Finish swaps/rollback independently of a user cancelling the upload.
  const request = new AbortController();
  const timer = setTimeout(() => request.abort(), 15000);
  try {
    const body = new URLSearchParams({ path: `${DESTINATION}/${filename}` });
    if (name) body.set('name', name);
    const response = await fetch(`/${action}`, { method: 'POST', body, signal: request.signal });
    if (!response.ok) throw new Error(`Reader could not ${action} ${filename} (${response.status}).`);
  } finally { clearTimeout(timer); }
}

export async function uploadEpub(file: File, signal: AbortSignal, report: Report, existing?: string): Promise<string | undefined> {
  if (!existing) {
    await transfer(file, signal, report);
    return;
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // The EPUB suffix makes firmware mark the Library index for refresh.
  const staged = `wp-${id}.part.epub`;
  const backup = `wp-${id}.bak`;
  const quiet: Report = (message, percent) => report(message.startsWith('Saved') ? 'New article uploaded. Preparing replacement…' : message, percent);
  // A partial/failed transfer is never swapped into the article's final path.
  await transfer(new File([file], staged, { type: file.type }), signal, quiet);
  checkCancelled(signal);
  report('Replacing existing article…');
  let moved = false;
  try {
    await fileAction('rename', existing, backup);
    moved = true;
    await fileAction('rename', staged, file.name);
  } catch (error) {
    if (moved) {
      try { await fileAction('rename', backup, existing); }
      catch { throw new Error(`Replacement could not be confirmed. Check ${DESTINATION}/${file.name}, ${backup} and ${staged} in File Manager; the original backup is preserved.`); }
      throw new Error('Replacement failed. The original article was restored. Please retry.');
    }
    throw new Error(`Replacement could not start. Check the original article and ${backup} in ${DESTINATION}; the new upload is ${staged}.`);
  }
  try { await fileAction('delete', backup); }
  catch { return `Old-copy cleanup failed. Delete ${DESTINATION}/${backup} in File Manager.`; }
}
