import { type Article, type Report, checkCancelled } from './types';
import { type ResolvedArticleRef, languageCode, loadArticle, parseArticleUrl, resolveArticle } from './wikipedia';

type Outcome = { state: 'pending' | 'saved' | 'failed'; detail: string };
type ResolvedItem = { ref: ResolvedArticleRef; outcome: Outcome };
type Item = ResolvedItem | { input: string; error: string };
type Phase = 'editing' | 'reviewing' | 'ready' | 'importing';
interface BatchActions {
  run(task: (signal: AbortSignal) => Promise<void>): Promise<void>;
  report: Report;
  save(article: Article, signal: AbortSignal, report: Report): Promise<string>;
}
const countArticles = (count: number) => `${count} article${count === 1 ? '' : 's'}`;
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please retry.';
const identity = (ref: ResolvedArticleRef) => `${ref.language}:${ref.pageId}`;
const isResolved = (item: Item): item is ResolvedItem => 'ref' in item;

export function mountBatch(host: HTMLElement, actions: BatchActions): void {
  host.innerHTML = `<h3>Add multiple articles</h3>
<p>Paste one Wikipedia URL or exact article title per line. Up to 25 articles. Titles use the language below; URLs use their own language.</p>
<label>Articles<textarea name="articles" maxlength="25000" placeholder="Maputo&#10;https://en.wikipedia.org/wiki/Mars"></textarea></label>
<label>Language for article titles<input type="text" name="batch-language" value="en" maxlength="31" autocapitalize="none" spellcheck="false"/></label>
<button type="button" class="wp-review">Review articles</button>
<div class="wp-batch-list" aria-label="Article review"></div>
<div class="wp-batch-options" hidden></div>
<div class="wp-actions"><button type="button" class="wp-save-batch wp-primary" hidden></button></div>
<p class="wp-muted wp-help">Keep this browser and the reader’s File Transfer screen open. Each article is saved as a separate EPUB in /Wikipedia. This list is kept only while the page stays open.</p>`;
  const find = <T extends HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  const input = find<HTMLTextAreaElement>('textarea');
  const language = find<HTMLInputElement>('[name=batch-language]');
  const list = find('.wp-batch-list');
  const save = find<HTMLButtonElement>('.wp-save-batch');
  const review = find<HTMLButtonElement>('.wp-review');
  const options = find('.wp-batch-options');
  let items: Item[] = [];
  let phase: Phase = 'editing';
  // Outcomes survive editing and re-review for this page session, including aliases.
  const outcomes = new Map<string, Outcome>();
  const rows = new Map<Item, { row: HTMLElement; detail: HTMLElement; remove: HTMLButtonElement }>();

  function render(): void {
    for (const [item, view] of rows) {
      if (!items.includes(item)) { view.row.remove(); rows.delete(item); }
    }
    for (const item of items) {
      let view = rows.get(item);
      if (!view) {
        const row = document.createElement('div');
        row.className = 'wp-batch-row';
        const title = document.createElement('strong');
        const name = isResolved(item) ? item.ref.title : item.input;
        title.textContent = isResolved(item) ? `${name} (${item.ref.language})` : name;
        const detail = document.createElement('p');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${name}`);
        remove.addEventListener('click', () => {
          const index = items.indexOf(item);
          items.splice(index, 1);
          render();
          const neighbour = items[index] || items[index - 1];
          (neighbour ? rows.get(neighbour)?.remove : review)?.focus();
          actions.report(`${countArticles(items.length)} in list.${items.some(entry => !isResolved(entry)) ? ' Remove invalid entries or edit the list and review again.' : ''}`);
        });
        row.append(title, remove, detail);
        list.append(row);
        view = { row, detail, remove };
        rows.set(item, view);
      }
      view.detail.textContent = isResolved(item) ? item.outcome.detail : item.error;
      view.detail.classList.toggle('wp-error', !isResolved(item) || item.outcome.state === 'failed');
      view.remove.disabled = phase !== 'ready';
    }
    const resolved = items.filter(isResolved);
    const pending = resolved.filter(item => item.outcome.state === 'pending').length;
    const failed = resolved.filter(item => item.outcome.state === 'failed').length;
    save.hidden = !['ready', 'importing'].includes(phase) || !(pending + failed);
    save.disabled = phase !== 'ready' || resolved.length !== items.length;
    save.textContent = pending ? `Add ${countArticles(pending + failed)} to reader` : `Retry failed (${failed})`;
    options.hidden = !['ready', 'importing'].includes(phase) || !resolved.length;
  }
  function invalidate(): void {
    phase = 'editing';
    items = [];
    render();
    actions.report('List changed. Review articles before importing.');
  }
  input.addEventListener('input', invalidate);
  language.addEventListener('input', invalidate);

  review.addEventListener('click', () => void actions.run(async signal => {
    const lines = input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length || lines.length > 25) throw new Error('Enter between 1 and 25 articles, one per line.');
    phase = 'reviewing';
    items = [];
    render();
    const seen = new Set<string>();
    let duplicates = 0;
    try {
      for (const [index, line] of lines.entries()) {
        checkCancelled(signal);
        actions.report(`Reviewing ${index + 1} of ${lines.length}…`);
        try {
          const ref = await resolveArticle(parseArticleUrl(line) || { language: languageCode(language.value), title: line }, signal);
          checkCancelled(signal);
          const key = identity(ref);
          if (seen.has(key)) { duplicates++; continue; }
          seen.add(key);
          const outcome = outcomes.get(key) || { state: 'pending', detail: 'Ready' };
          outcomes.set(key, outcome);
          items.push({ ref, outcome });
        } catch (error) {
          checkCancelled(signal);
          items.push({ input: line, error: message(error) });
        }
        render();
      }
      phase = 'ready';
      actions.report(`${countArticles(items.length)} reviewed.${duplicates ? ` ${duplicates} duplicate entries removed.` : ''}${items.some(item => !isResolved(item)) ? ' Remove invalid entries or edit the list and review again.' : ' Ready to import.'}`);
    } finally {
      if (phase === 'reviewing') phase = 'editing';
      render();
    }
  }));

  save.addEventListener('click', () => {
    if (phase !== 'ready' || items.some(item => !isResolved(item))) return;
    void actions.run(async signal => {
      const jobs = items.filter(isResolved).filter(item => item.outcome.state !== 'saved');
      phase = 'importing';
      render();
      try {
        for (const [index, item] of jobs.entries()) {
          checkCancelled(signal);
          const prefix = `Saving ${index + 1} of ${jobs.length} — ${item.ref.title}`;
          item.outcome.detail = 'Saving…';
          render();
          const report: Report = (text, percent) => actions.report(`${prefix}: ${text}`, percent);
          try {
            report('Loading article…');
            const article = await loadArticle(item.ref, signal);
            checkCancelled(signal);
            const detail = await actions.save(article, signal, report);
            item.outcome.state = 'saved';
            item.outcome.detail = `Saved.${detail ? ` ${detail}` : ''}`;
          } catch (error) {
            if (signal.aborted) {
              item.outcome.detail = 'Cancelled. Ready to retry.';
              throw error;
            }
            item.outcome.state = 'failed';
            item.outcome.detail = message(error);
          }
          render();
        }
        const resolved = items.filter(isResolved);
        const failed = resolved.filter(item => item.outcome.state === 'failed').length;
        actions.report(`${countArticles(resolved.filter(item => item.outcome.state === 'saved').length)} saved to /Wikipedia.${failed ? ` ${failed} failed. Retry failed to try again.` : ' Exit File Transfer to read them.'}`, 100);
      } finally {
        phase = 'ready';
        render();
      }
    });
  });
}
