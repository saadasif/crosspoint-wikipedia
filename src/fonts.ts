import { type PluginApi, type Report, checkCancelled } from './types';
import { getZip } from './zip';
import pack from './font-pack.json';

type Run = (task: (signal: AbortSignal) => Promise<void>) => Promise<void>;
interface Family { name: string; files: { name: string; size: number }[] }

async function readerJson<T>(path: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, signal });
  if (!response.ok) throw new Error('Font setup failed. Check the reader connection and firmware font support, then retry.');
  return response.json();
}

export function mountFonts(host: HTMLElement, api: PluginApi, run: Run, report: Report): void {
  const content = document.createElement('div');
  const installedMB = Math.ceil(pack.files.reduce((total, font) => total + font.bytes, 0) / 1_000_000);
  content.innerHTML = `<p>Inter Wiki offers an iPhone-like reading style with Arabic, Hebrew, Armenian, Georgian and Ethiopic characters, pronunciation symbols, and scientific, chess and decorative symbols including spirals. Some scripts, including Japanese, Chinese, Korean, Indic and Thai, remain unsupported. Installs 12, 14, 16 and 18 pt (about ${installedMB} MB on the reader).</p><button type="button" class="wp-font-install">Install Inter</button><p class="wp-muted">After installation, choose InterWiki in Settings → Reader → Font Family. Reader font settings apply to all books.</p>`;
  host.append(content);
  content.querySelector('.wp-font-install')!.addEventListener('click', () => void run(async signal => {
    report('Checking installed fonts…');
    const listing = await readerJson<{ families: Family[] }>('/api/fonts', signal);
    if (!Array.isArray(listing.families)) throw new Error('This firmware does not expose installed fonts. Use the reader’s Fonts page.');
    const installed = listing.families.find(family => family.name === pack.family);
    const missing = pack.files.filter(font => !installed?.files?.some(file => file.name === font.name && file.size === font.bytes));
    if (missing.length) {
      report('Preparing Inter font files…');
      const Zip = await getZip(signal);
      const response = await fetch(api.pluginFile('inter-fonts.zip'), { signal });
      if (!response.ok) throw new Error('Inter font pack unavailable. Reinstall the plugin and retry.');
      const zip = await Zip.loadAsync(await response.arrayBuffer(), { checkCRC32: true });
      for (const [index, font] of missing.entries()) {
        checkCancelled(signal);
        const { name, size } = font;
        const entry = zip.file(`${pack.family}/${name}`);
        if (!entry) throw new Error('Incomplete Inter font pack. Reinstall the plugin.');
        const bytes = await entry.async('uint8array');
        if (bytes.length !== font.bytes || new TextDecoder().decode(bytes.subarray(0, 6)) !== 'CPFONT') throw new Error('Invalid Inter font file. Reinstall the plugin.');
        checkCancelled(signal);
        report(`Installing Inter ${size} pt (${index + 1}/${missing.length})…`);
        const form = new FormData();
        form.append('family', pack.family);
        form.append('file', new Blob([new Uint8Array(bytes).buffer]), name);
        const result = await readerJson<{ ok?: boolean }>('/api/fonts/upload', signal, { method: 'POST', body: form });
        if (!result.ok) throw new Error('Inter upload failed. Retry to install the remaining sizes.');
      }
    }
    report('Inter is installed. Select InterWiki in Settings → Reader → Font Family.', 100);
  }));
}
