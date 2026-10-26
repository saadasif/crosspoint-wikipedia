import type JSZip from 'jszip';

export interface PluginApi {
  pluginFile(file: string): string;
}

declare global {
  interface Window {
    CrossPoint: { registerPlugin(render: (container: HTMLElement, api: PluginApi) => void): void };
    JSZip?: typeof JSZip;
  }
}

export interface PageRef {
  language: string;
  title: string;
  revision?: number;
}

export interface Article extends PageRef {
  pageId: number;
  revision: number;
  html: string;
  source: string;
  license: { text: string; url: string };
  rtl: boolean;
}

export interface ImageAsset {
  path: string;
  data: Uint8Array;
  title: string;
  artist: string;
  license: string;
  licenseUrl: string;
  source: string;
  mediaType?: 'image/jpeg' | 'image/png';
}

export interface EquationTools {
  normalize(root: ParentNode, doc: Document): void;
  prepare(root: HTMLElement, article: Article, signal: AbortSignal, report: Report): Promise<ImageAsset[]>;
}

export interface Section {
  title: string;
  file: string;
  body: HTMLElement;
}

export type Report = (message: string, progress?: number) => void;

export function abortError(): DOMException {
  return new DOMException('Cancelled', 'AbortError');
}

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

export function plainText(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.textContent?.trim() || '';
}

export function escapeXml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}
