import { type Article, type EquationTools } from './types';
import { normalizeTables } from './tables';

const ALLOWED = new Set('p div span section article aside h1 h2 h3 h4 h5 h6 strong b em i s u sub sup ul ol li dl dt dd blockquote pre code hr br table caption thead tbody tfoot tr th td img figure figcaption'.split(' '));
const REMOVE = 'script,style,link,iframe,object,embed,form,input,button,textarea,select,svg,video,audio,nav,.navbox,.vertical-navbox,.metadata,.ambox,.sistersitebox,.mw-editsection,.noprint,.nomobile,.mw-empty-elt,.hatnote,.toc,#toc,.mw-references-wrap,.reflist,.references,.reference,.mw-ref,.mw-cite-backlink,.ext-phonos,.navbar,.sidebar,.portalbox,.portal-bar,.portalborder,.authority-control,.dablink,.rellink,.galleryfilename,.magnify';
export function imageUrl(value: string, source: string): string | undefined {
  try {
    const url = new URL(value, source);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return;
    if (!['upload.wikimedia.org', 'thumb.wikimedia.org', 'math.wikimedia.org'].includes(url.hostname)) return;
    return url.href;
  } catch { return; }
}

function safeLink(value: string, source: string): string | undefined {
  try {
    const url = new URL(value, source);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    return url.href;
  } catch { return; }
}

function normalizeFigures(root: ParentNode, doc: Document): void {
  // Gallery captions are explicitly attached to individual entries in MediaWiki.
  for (const gallery of root.querySelectorAll('ul.gallery')) {
    const group = doc.createElement('div');
    for (const entry of Array.from(gallery.children)) {
      const figure = doc.createElement(entry.matches('.gallerybox') && entry.querySelector('img') ? 'figure' : 'div');
      const caption = entry.querySelector('.gallerytext');
      if (caption && figure.tagName === 'FIGURE') {
        const legend = doc.createElement('figcaption');
        legend.append(...caption.childNodes);
        caption.remove();
        figure.append(...entry.childNodes, legend);
      } else figure.append(...entry.childNodes);
      if (figure.textContent?.trim() || figure.querySelector('img')) group.append(figure);
    }
    gallery.replaceWith(group);
  }
  for (const thumb of Array.from(root.querySelectorAll('.thumb:not(.tmulti),.tsingle')).reverse()) {
    const caption = thumb.querySelector('.thumbcaption');
    if (!caption || !thumb.querySelector('img')) continue;
    const figure = doc.createElement('figure');
    const legend = doc.createElement('figcaption');
    legend.append(...caption.childNodes);
    caption.replaceWith(legend);
    const inner = thumb.querySelector('.thumbinner') || thumb;
    figure.append(...inner.childNodes);
    thumb.replaceWith(figure);
  }
}

// Stripping positions and connector lines would change these templates' meaning.
function omitSpatialDiagrams(root: ParentNode, doc: Document): void {
  for (const diagram of root.querySelectorAll('.chessboard,table.tree-chart,.mw-kartographer-container,.mw-kartographer-map')) {
    if (!root.contains(diagram)) continue;
    const block = doc.createElement('div');
    const notice = doc.createElement('p');
    const kind = diagram.matches('.chessboard') ? 'chessboard diagram' : diagram.matches('table.tree-chart') ? 'family tree diagram' : 'map';
    notice.textContent = `A ${kind} was omitted from this edition.`;
    block.append(notice);
    const captions = Array.from(diagram.querySelectorAll('.thumbcaption,figcaption,caption'));
    if (diagram.matches('.chessboard')) captions.unshift(...diagram.querySelectorAll(':scope > .center'));
    for (const caption of captions) {
      if (!caption.textContent?.trim()) continue;
      const text = doc.createElement('p');
      text.append(...caption.childNodes);
      block.append(text);
    }
    diagram.replaceWith(block);
  }
}

function imageSource(node: Element, source: string): string | undefined {
  let selected = imageUrl(node.getAttribute('src') || '', source);
  let density = 0;
  for (const candidate of (node.getAttribute('srcset') || '').split(/,\s*(?=(?:https?:)?\/\/)/)) {
    const match = candidate.trim().match(/^(\S+)\s+([\d.]+)[wx]$/);
    const url = match && imageUrl(match[1], source);
    if (url && Number(match![2]) > density) {
      selected = url;
      density = Number(match![2]);
    }
  }
  return selected;
}

function removeSections(root: DocumentFragment): void {
  const headings = Array.from(root.querySelectorAll('h2,h3,h4,h5,h6'));
  const excluded = new Set('see also|note|notes|explanatory notes|footnote|footnotes|endnote|endnotes|references|citations|bibliography|works cited|further reading|further readings|external links|sources|image credits|contents|table of contents'.split('|'));
  for (const heading of headings) {
    if (!root.contains(heading) || !(heading.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ').split(/ (?:and|&) /).every(part => excluded.has(part))) continue;
    const next = headings.slice(headings.indexOf(heading) + 1).find(node => root.contains(node) && node.tagName <= heading.tagName);
    const range = root.ownerDocument.createRange();
    range.setStartBefore(heading);
    if (next) range.setEndBefore(next);
    else range.setEnd(root, root.childNodes.length);
    range.deleteContents();
  }
}

function normalizeBlockParents(root: HTMLElement, doc: Document): void {
  const phrasing = 'p,span,strong,b,em,i,u,s,sub,sup,code,pre,h1,h2,h3,h4,h5,h6';
  const blocks = 'div,p,section,article,aside,h1,h2,h3,h4,h5,h6,ul,ol,dl,blockquote,pre,table,figure';
  for (const el of Array.from(root.querySelectorAll(phrasing)).reverse()) {
    if (!el.querySelector(blocks)) continue;
    const block = doc.createElement('div');
    if (el.hasAttribute('dir')) block.setAttribute('dir', el.getAttribute('dir')!);
    if (['STRONG', 'B'].includes(el.tagName)) block.className = 'wp-bold';
    if (['EM', 'I'].includes(el.tagName)) block.className = 'wp-italic';
    block.append(...el.childNodes);
    el.replaceWith(block);
  }
}

function normalizeTermHeadings(root: HTMLElement, doc: Document): void {
  for (const list of root.querySelectorAll('dl')) {
    if (!list.children.length || !Array.from(list.children).every(child => child.tagName === 'DT')) continue;
    const block = doc.createElement('div');
    if (list.hasAttribute('dir')) block.setAttribute('dir', list.getAttribute('dir')!);
    for (const term of Array.from(list.children)) {
      const paragraph = doc.createElement('p');
      if (term.hasAttribute('dir')) paragraph.setAttribute('dir', term.getAttribute('dir')!);
      const bold = doc.createElement('strong');
      bold.append(...term.childNodes);
      paragraph.append(bold);
      block.append(paragraph);
    }
    list.replaceWith(block);
  }
}

export function cleanArticle(article: Article, equations?: EquationTools): HTMLElement {
  // Template documents keep image URLs inert throughout cleanup and packaging.
  const template = document.createElement('template');
  template.innerHTML = article.html;
  const fragment = template.content;
  const doc = fragment.ownerDocument;
  if (equations) equations.normalize(fragment, doc);
  else for (const math of fragment.querySelectorAll('.mwe-math-element,math')) math.replaceWith('(equation)');
  // Stripping styles must not expose invisible sort keys, layout placeholders,
  // or duplicate template text. Extract equation alternatives before this pass.
  for (const node of fragment.querySelectorAll<HTMLElement>('[hidden],[style]')) {
    if (node.hasAttribute('hidden') || node.style?.display === 'none' || node.style?.visibility === 'hidden') node.remove();
  }
  // Remove the complete media entry before dropping unsupported player elements.
  // IPA and pronunciation prose outside these wrappers remain readable.
  for (const media of fragment.querySelectorAll('audio,video')) {
    const entry = media.closest('.gallerybox') || media.closest('figure,.thumb');
    if (entry && !entry.querySelector('img')) entry.remove();
  }
  fragment.querySelectorAll(REMOVE).forEach(node => node.remove());
  for (const link of fragment.querySelectorAll('a[href*="#cite_note"],a[href*="#cite_ref"]')) (link.closest('sup') || link).remove();
  for (const wrapper of fragment.querySelectorAll('.mw-heading')) wrapper.replaceWith(...wrapper.childNodes);
  removeSections(fragment);
  const sourceRoot = fragment.querySelector('.mw-parser-output') || fragment;
  const lead = Array.from(sourceRoot.children).find(node => node.tagName === 'P' && node.textContent?.trim());
  if (lead) sourceRoot.prepend(lead);
  omitSpatialDiagrams(fragment, doc);
  normalizeFigures(fragment, doc);
  normalizeTables(fragment, doc);
  const source = fragment.querySelector('.mw-parser-output') || fragment;
  const output = doc.createElement('div');
  function copy(node: Node, parent: HTMLElement, depth: number): void {
    if (depth > 80) return;
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append((node.textContent || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (!ALLOWED.has(tag)) {
      for (const child of node.childNodes) copy(child, parent, depth + 1);
      return;
    }
    // Wikipedia uses termless definition lists for indentation, not definitions.
    const indent = tag === 'dl' && node.children.length > 0 && Array.from(node.children).every(child => child.tagName === 'DD');
    const el = doc.createElement(indent ? 'blockquote' : tag === 'dd' && parent.localName === 'blockquote' ? 'div' : tag);
    if (['rtl', 'ltr'].includes(node.getAttribute('dir') || '')) el.setAttribute('dir', node.getAttribute('dir')!);
    for (const name of ['wp-facts', 'wp-fact', 'wp-table', 'wp-table-row', 'wp-inline-math']) {
      if (node.classList.contains(name)) el.className = name;
    }
    if (tag === 'span' && node.hasAttribute('data-wp-math')) el.setAttribute('data-wp-math', node.getAttribute('data-wp-math')!);
    if (tag === 'img') {
      const src = imageSource(node, article.source);
      if (!src) return;
      const width = Number(node.getAttribute('width'));
      const height = Number(node.getAttribute('height'));
      if (width > 0 && height > 0 && width < 40 && height < 40) return;
      el.setAttribute('data-src', src);
      el.setAttribute('alt', node.getAttribute('alt') || 'Article image');
      const link = node.closest('a[href]');
      const file = link && safeLink(link.getAttribute('href')!, article.source);
      if (file) {
        const url = new URL(file);
        if (url.pathname.startsWith('/wiki/')) {
          const title = decodeURIComponent(url.pathname.slice(6));
          if (title.includes(':')) el.setAttribute('data-file', title);
        }
      }
    }
    if (tag === 'td' || tag === 'th') {
      for (const attr of ['colspan', 'rowspan']) {
        const value = Number(node.getAttribute(attr));
        if (value > 1 && value < 10) el.setAttribute(attr, String(value));
      }
    }
    if (tag === 'ol' || tag === 'li') {
      const attr = tag === 'ol' ? 'start' : 'value';
      const value = node.getAttribute(attr);
      if (value && /^\d{1,6}$/.test(value)) el.setAttribute(attr, value);
    }
    for (const child of node.childNodes) copy(child, el, depth + 1);
    parent.append(el);
  }
  for (const child of source.childNodes) copy(child, output, 0);
  normalizeTermHeadings(output, doc);
  normalizeBlockParents(output, doc);
  return output;
}

export function summarizeArticle(article: Article): string {
  const root = cleanArticle(article);
  const lead = Array.from(root.querySelectorAll('p')).find(p => !p.closest('.wp-facts') && (p.textContent?.trim().length || 0) > 60);
  const text = lead?.textContent?.trim() || root.textContent?.trim() || '';
  return text.length > 280 ? `${text.slice(0, 280).replace(/\s+\S*$/, '')}…` : text;
}
