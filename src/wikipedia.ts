import { type Article, type PageRef, plainText } from './types';

export function languageCode(value: string): string {
  const code = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(code)) throw new Error('Enter a Wikipedia language code, such as en, fr, or simple.');
  return code;
}

export function parseArticleUrl(input: string): PageRef | undefined {
  if (!/^(?:https?:\/\/|[\w-]+\.(?:m\.)?wikipedia\.org\/)/i.test(input)) return;
  let url: URL;
  try { url = new URL(input.includes('://') ? input : `https://${input}`); }
  catch { throw new Error('Enter a valid Wikipedia article URL.'); }
  const match = /^([a-z][a-z0-9-]*)\.(?:m\.)?wikipedia\.org$/.exec(url.hostname);
  if (!match || ['www', 'm'].includes(match[1]) || url.port || url.username || url.password) {
    throw new Error('Use an article URL from a Wikipedia language edition.');
  }
  const title = url.pathname.startsWith('/wiki/')
    ? decodeURIComponent(url.pathname.slice(6)).replace(/_/g, ' ')
    : url.pathname === '/w/index.php' ? url.searchParams.get('title') : null;
  if (!title) throw new Error('This URL does not identify a Wikipedia article.');
  const oldId = url.searchParams.get('oldid');
  if (oldId && !/^\d+$/.test(oldId)) throw new Error('Invalid article revision.');
  return { language: languageCode(match[1]), title, ...(oldId ? { revision: Number(oldId) } : {}) };
}

export async function wikiRequest<T>(language: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ ...params, format: 'json', formatversion: '2', origin: '*' });
  const response = await fetch(`https://${languageCode(language)}.wikipedia.org/w/api.php?${query}`, {
    signal, credentials: 'omit', headers: { 'Api-User-Agent': 'CrossPointWikipedia/0.1 (https://github.com/saadasif/crosspoint-wikipedia)' },
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'Wikipedia is busy. Please retry shortly.' : `Wikipedia request failed (${response.status}).`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.info || 'Wikipedia could not find this article.');
  return data as T;
}

export interface SearchHit { title: string; snippet: string; }

export async function searchArticles(query: string, language: string, signal: AbortSignal): Promise<SearchHit[]> {
  const data = await wikiRequest<{ query: { search: SearchHit[] } }>(language, {
    action: 'query', list: 'search', srsearch: query, srnamespace: '0', srlimit: '6', srprop: 'snippet',
  }, signal);
  return data.query.search.map(hit => ({ title: hit.title, snippet: plainText(hit.snippet) }));
}

export interface ResolvedArticleRef extends PageRef {
  pageId: number;
  revision: number;
}

export async function resolveArticle(ref: PageRef, signal: AbortSignal): Promise<ResolvedArticleRef> {
  const { parse: page } = await wikiRequest<{ parse: { title: string; pageid: number; revid: number } }>(ref.language, {
    action: 'parse', prop: 'revid', redirects: '1',
    ...(ref.revision ? { oldid: String(ref.revision) } : { page: ref.title }),
  }, signal);
  if (!page.pageid || !page.revid || !page.title) throw new Error('Wikipedia returned an empty article.');
  return { language: ref.language, title: page.title, pageId: page.pageid, revision: page.revid };
}

export async function loadArticle(ref: PageRef, signal: AbortSignal): Promise<Article> {
  const [data, site] = await Promise.all([
    wikiRequest<{ parse: { title: string; pageid: number; revid: number; text: string } }>(ref.language, {
      action: 'parse', prop: 'text|revid', redirects: '1', disableeditsection: '1',
      ...(ref.revision ? { oldid: String(ref.revision) } : { page: ref.title }),
    }, signal),
    wikiRequest<{ query: { general: { rtl?: boolean }; rightsinfo: { text: string; url: string } } }>(ref.language, {
      action: 'query', meta: 'siteinfo', siprop: 'general|rightsinfo',
    }, signal),
  ]);
  const page = data.parse;
  if (!page.pageid || !page.revid || !page.text) throw new Error('Wikipedia returned an empty article.');
  const rights = site.query.rightsinfo;
  if (!rights.text || !/^https:\/\//.test(rights.url)) throw new Error('Could not determine this article’s license.');
  return {
    ...ref, title: page.title, pageId: page.pageid, revision: page.revid, html: page.text,
    source: `https://${ref.language}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    license: rights, rtl: Boolean(site.query.general.rtl),
  };
}
