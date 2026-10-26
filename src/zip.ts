import type JSZip from 'jszip';
import { abortError, checkCancelled } from './types';

let loading: Promise<typeof JSZip> | undefined;

export async function getZip(signal: AbortSignal): Promise<typeof JSZip> {
  checkCancelled(signal);
  if (window.JSZip) return window.JSZip;
  loading ??= loadZip().catch(error => { loading = undefined; throw error; });
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    loading!.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function loadZip(): Promise<typeof JSZip> {
  // Current File Manager already loads JSZip; these are compatibility fallbacks.
  for (const url of ['/js/jszip.min.js', 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js']) {
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => { script.remove(); reject(new Error('Library load timed out.')); }, 12000);
        script.src = url;
        if (url.startsWith('https:')) {
          script.integrity = 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG';
          script.crossOrigin = 'anonymous';
        }
        script.onload = () => { clearTimeout(timer); script.remove(); resolve(); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Library unavailable.')); };
        document.head.append(script);
      });
      if (window.JSZip) return window.JSZip;
    } catch { /* Try the next pinned source. */ }
  }
  throw new Error('Could not load EPUB packaging tools. Check your connection and retry.');
}
