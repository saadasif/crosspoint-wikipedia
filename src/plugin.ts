import { mountBatch } from './batch';
import { PHOTO_LIMIT, PHOTO_BYTES } from './limits';
import { type Article, type PageRef, type PluginApi, type Report, checkCancelled } from './types';
import { languageCode, loadArticle, parseArticleUrl, searchArticles } from './wikipedia';

function mount(container: HTMLElement, api: PluginApi): void {
  container.classList.add('cp-wikipedia');
  container.innerHTML = `<style>
.cp-wikipedia{line-height:1.5;line-break:auto;word-break:normal;overflow-wrap:break-word}
.cp-wikipedia fieldset{border:0;padding:0;margin:0;min-width:0}.cp-wikipedia form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}
.cp-wikipedia label{display:block}.cp-wikipedia .wp-query{grid-column:1/-1}
.cp-wikipedia .wp-query-row{display:flex;gap:8px}.cp-wikipedia .wp-query-row input{min-width:0;flex:1}
.cp-wikipedia textarea{width:100%;box-sizing:border-box;font:inherit;min-height:160px}.cp-wikipedia .wp-batch-row{padding:10px 0;border-bottom:1px solid #bbb}.cp-wikipedia .wp-batch-row p{margin:.25em 0}.cp-wikipedia .wp-review{margin-top:10px}.cp-wikipedia .wp-batch-row button{margin-left:8px}
.cp-wikipedia input[type=text]{width:100%;box-sizing:border-box;min-height:44px;font-size:16px}
.cp-wikipedia .wp-language{max-width:150px}.cp-wikipedia button{min-height:44px;cursor:pointer;font:inherit}
.cp-wikipedia button:disabled{cursor:wait}.cp-wikipedia :is(button,input,a,summary):focus-visible{outline:2px solid #1769aa;outline-offset:3px}
.cp-wikipedia .wp-primary{background:#205b48;color:#fff;border:1px solid #205b48;font-weight:600;padding:8px 16px}
.cp-wikipedia .wp-result{display:block;width:100%;text-align:left;padding:12px;margin:8px 0}
.cp-wikipedia .wp-result small{display:block;margin-top:4px;font-weight:normal}
.cp-wikipedia .wp-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
.cp-wikipedia .wp-actions button{flex:1;padding:8px 12px}
.cp-wikipedia .wp-option{margin-top:12px}.cp-wikipedia .wp-help{font-size:.875em;margin:.3em 0 .8em}
.cp-wikipedia .wp-preview{border-top:1px solid #bbb;padding-top:16px;margin-top:16px}
.cp-wikipedia .wp-preview h3{margin:0}.cp-wikipedia .wp-summary{margin:.5em 0}
.cp-wikipedia .wp-fonts{border-top:1px solid #bbb;margin-top:20px;padding-top:12px}
.cp-wikipedia summary{cursor:pointer}.cp-wikipedia progress{width:100%;margin-top:8px}
.cp-wikipedia [hidden]{display:none!important}.cp-wikipedia .wp-error{color:#b42318}
.cp-wikipedia .wp-muted{opacity:.8}.cp-wikipedia .wp-status:empty{display:none}
</style>
<h2>Wikipedia</h2>
<p class="wp-muted">Save an article to /Wikipedia and read it offline.</p>
<fieldset class="wp-controls">
<button type="button" class="wp-mode">Add multiple articles</button>
<div class="wp-single">
<form>
<label class="wp-query">Article title or Wikipedia URL<span class="wp-query-row"><input type="text" name="query" maxlength="1000" placeholder="Search or paste a Wikipedia link" required autocomplete="off" autocapitalize="none"/>
<button type="button" class="wp-clear" aria-label="Clear article query">Clear</button></span></label>
<label class="wp-language">Language<input type="text" name="language" value="en" maxlength="31" aria-label="Wikipedia language" autocapitalize="none" spellcheck="false"/></label>
<button type="submit" class="wp-primary">Search</button>
</form>
<p class="wp-muted wp-help">Touch and hold the textbox or right-click to paste.</p>
<div class="wp-results" aria-label="Search results"></div>
<section class="wp-preview" hidden aria-label="Article preview">
<h3></h3><p class="wp-summary"></p><p><a class="wp-source" target="_blank" rel="noopener noreferrer">Read original article</a></p>
<div class="wp-options"><label class="wp-option"><input type="checkbox" name="images" checked/> Include optimized images</label>
<p class="wp-muted wp-help">Up to ${PHOTO_LIMIT} grayscale photos (${PHOTO_BYTES / 1_000_000} MB total). Formulas are included separately.</p>
<label class="wp-option"><input type="checkbox" name="replace" checked/> Replace existing article</label>
<p class="wp-muted wp-help">For reader saves only. Replacing resets reading progress and removes saved clippings.</p>
<p class="wp-muted wp-help">Complex tables and diagrams may be omitted. Check the original for the complete layout.</p>
</div><div class="wp-actions"><button type="button" class="wp-import wp-primary">Add to reader</button><button type="button" class="wp-download">Download EPUB</button></div>
<p class="wp-muted wp-help">Add to reader saves in /Wikipedia. Download EPUB saves to this phone or computer.</p>
</section>
</div><section class="wp-batch" hidden aria-label="Multiple articles"></section></fieldset>
<div class="wp-feedback">
<p role="status" aria-live="polite" class="wp-status"></p>
<progress max="100" hidden aria-label="Import progress"></progress>
<button type="button" class="wp-cancel" hidden>Cancel</button>
</div>
<fieldset class="wp-font-controls"><details class="wp-fonts"><summary>Optional reader font</summary></details></fieldset>`;
  const find = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
  const form = find<HTMLFormElement>('form');
  const query = find<HTMLInputElement>('[name=query]');
  const language = find<HTMLInputElement>('[name=language]');
  const results = find('.wp-results');
  const preview = find('.wp-preview');
  const status = find('.wp-status');
  const feedback = find('.wp-feedback');
  const fonts = find('.wp-fonts');
  const controls = find<HTMLFieldSetElement>('.wp-controls');
  const fontControls = find<HTMLFieldSetElement>('.wp-font-controls');
  const progress = find<HTMLProgressElement>('progress');
  const cancel = find<HTMLButtonElement>('.wp-cancel');
  const includeImages = find<HTMLInputElement>('[name=images]');
  const replace = find<HTMLInputElement>('[name=replace]');
  let article: Article | undefined;
  let controller: AbortController | undefined;
  let cached: { article: Article; images: boolean; epub: Awaited<ReturnType<typeof import('./epub').buildEpub>> } | undefined;
  const converter = (): Promise<typeof import('./epub')> => import(api.pluginFile('epub.js'));

  const report: Report = (message, percent) => {
    status.textContent = message;
    status.classList.remove('wp-error');
    progress.hidden = percent === undefined;
    if (percent !== undefined) progress.value = percent;
  };

  async function run(task: (signal: AbortSignal) => Promise<void>, activeControls = controls): Promise<void> {
    if (controller) return;
    // Keep shared status, progress and cancellation beside the active controls.
    activeControls.after(feedback);
    container.setAttribute('aria-busy', 'true');
    controller = new AbortController();
    controls.disabled = true;
    fontControls.disabled = true;
    cancel.hidden = false;
    cancel.disabled = false;
    try { await task(controller.signal); }
    catch (error) {
      progress.hidden = true;
      status.textContent = error instanceof Error && error.name === 'AbortError'
        ? 'Cancelled.' : error instanceof Error ? error.message : 'Something went wrong. Please retry.';
      status.classList.toggle('wp-error', !(error instanceof Error && error.name === 'AbortError'));
    } finally {
      controller = undefined;
      container.removeAttribute('aria-busy');
      cancel.hidden = true;
      controls.disabled = false;
      fontControls.disabled = false;
    }
  }

  // Safari places the caret after focus; select after the first click instead.
  query.addEventListener('focus', () => {
    query.addEventListener('click', () => query.select(), { once: true });
  });

  find('.wp-clear').addEventListener('click', () => {
    query.value = '';
    query.focus();
  });

  find('.wp-fonts').addEventListener('toggle', () => {
    void import(api.pluginFile('fonts.js')).then(module => module.mountFonts(fonts, api, (task: Parameters<typeof run>[0]) => run(task, fontControls), report)).catch(() => report('Font setup unavailable. Reload to retry.'));
  }, { once: true });

  async function showArticle(ref: PageRef, signal: AbortSignal): Promise<void> {
    article = undefined;
    preview.hidden = true;
    report('Loading article…');
    cached = undefined;
    const [loaded, { summarizeArticle }] = await Promise.all([loadArticle(ref, signal), converter()]);
    checkCancelled(signal);
    article = loaded;
    language.value = loaded.language;
    results.replaceChildren();
    find('.wp-preview h3').textContent = loaded.title;
    find('.wp-summary').textContent = summarizeArticle(loaded);
    find<HTMLAnchorElement>('.wp-source').href = loaded.source;
    replace.checked = true;
    preview.hidden = false;
    report('Ready to import.');
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    void run(async signal => {
      const input = query.value.trim();
      if (!input) throw new Error('Enter an article title or Wikipedia URL.');
      const ref = parseArticleUrl(input);
      if (ref) { await showArticle(ref, signal); return; }
      const code = languageCode(language.value);
      report('Searching Wikipedia…');
      article = undefined;
      preview.hidden = true;
      results.replaceChildren();
      const hits = await searchArticles(input, code, signal);
      for (const hit of hits) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wp-result';
        const title = document.createElement('strong');
        title.textContent = hit.title;
        const snippet = document.createElement('small');
        snippet.textContent = hit.snippet;
        button.append(title, snippet);
        button.addEventListener('click', () => { void run(signal => showArticle({ language: code, title: hit.title }, signal)); });
        results.append(button);
      }
      report(hits.length ? 'Choose an article to preview.' : 'No articles found. Try another title.');
    });
  });

  async function create(signal: AbortSignal, selected = article, notify: Report = report) {
    if (!selected) throw new Error('Choose an article first.');
    if (cached?.article === selected && cached.images === includeImages.checked) return cached.epub;
    const { buildEpub } = await converter();
    let equations;
    if (selected.html.includes('mwe-math-element') || selected.html.includes('<math')) {
      notify('Preparing equations…');
      try { equations = await import(api.pluginFile('equations.js')); }
      catch { throw new Error('Equation tools unavailable. Reinstall the plugin.'); }
    }
    const epub = await buildEpub(selected, includeImages.checked, signal, notify, equations);
    cached = { article: selected, images: includeImages.checked, epub };
    return epub;
  }

  async function saveArticle(selected: Article, signal: AbortSignal, notify: Report): Promise<string> {
    notify('Checking reader…');
    const [{ prepareDestination, uploadEpub }, { articleFilename }] = await Promise.all([import(api.pluginFile('transfer.js')), converter()]);
    checkCancelled(signal);
    const existing = await prepareDestination(articleFilename(selected), replace.checked, signal);
    const epub = await create(signal, selected, notify);
    const file = new File([new Uint8Array(epub.bytes).buffer], epub.filename, { type: 'application/epub+zip' });
    const detail = await uploadEpub(file, signal, notify, existing);
    return `${detail || ''}${epub.skippedImages ? ` ${epub.skippedImages} images were omitted (unavailable, unverified, or outside image limits).` : ''}`.trim();
  }

  find('.wp-import').addEventListener('click', () => {
    void run(async signal => {
      if (!article) return;
      const detail = await saveArticle(article, signal, report);
      report(`Saved to /Wikipedia. Exit File Transfer to read it.${detail ? ` ${detail}` : ''}`, 100);
    });
  });

  mountBatch(find('.wp-batch'), {
    run, report, save: async (selected, signal, notify) => {
      try { return await saveArticle(selected, signal, notify); }
      finally { cached = undefined; }
    },
  });
  const mode = find<HTMLButtonElement>('.wp-mode');
  mode.addEventListener('click', () => {
    const batch = find('.wp-batch');
    batch.hidden = !batch.hidden;
    find('.wp-single').hidden = !batch.hidden;
    mode.textContent = batch.hidden ? 'Add multiple articles' : 'Back to single article';
    if (batch.hidden) find('.wp-actions').before(find('.wp-options'));
    else find('.wp-batch-options').append(find('.wp-options'));
    status.textContent = '';
    progress.hidden = true;
    cached = undefined;
  });

  find('.wp-download').addEventListener('click', () => {
    void run(async signal => {
      const epub = await create(signal);
      const url = URL.createObjectURL(new Blob([new Uint8Array(epub.bytes).buffer], { type: 'application/epub+zip' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = epub.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      report(`EPUB downloaded.${epub.skippedImages ? ` ${epub.skippedImages} images were omitted.` : ''}`);
    });
  });
  cancel.addEventListener('click', () => controller?.abort());
}

window.CrossPoint.registerPlugin(mount);
