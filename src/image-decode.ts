import { abortError, checkCancelled } from './types';

// Photos and equations share browser decoding, but keep their own rendering rules.
export async function decodeImage(blob: Blob, signal: AbortSignal, timeout: number, label: string): Promise<HTMLImageElement> {
  checkCancelled(signal);
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => finish(abortError());
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        image.onload = image.onerror = null;
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error(`${label} decode timed out.`)), timeout);
      image.onload = () => finish();
      image.onerror = () => finish(new Error(`${label} decode failed.`));
      signal.addEventListener('abort', abort, { once: true });
      image.src = url;
    });
    checkCancelled(signal);
    return image;
  } finally { URL.revokeObjectURL(url); }
}
