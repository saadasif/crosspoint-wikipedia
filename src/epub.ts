import { cleanArticle } from './document';
import { sectionArticle } from './sections';
export { summarizeArticle } from './document';
import { prepareImages } from './images';
import { type Article, type ImageAsset, type Report, type EquationTools, checkCancelled, escapeXml } from './types';
import { getZip } from './zip';

const CSS = `h1,h2,h3,h4,h5,h6{text-align:left;page-break-after:avoid}body{margin:0;padding:0;text-align:left;text-indent:0;overflow-wrap:break-word}p{margin:0 0 .7em;text-indent:0}h1{font-size:1.7em;margin:0 0 .6em;border-bottom:1px solid #777;padding-bottom:.3em}h2{font-size:1.3em;margin:1.1em 0 .5em;border-bottom:1px solid #aaa;padding-bottom:.2em}h3{font-size:1.1em;margin:1em 0 .4em}h4{font-size:1em;margin:.8em 0 .4em}ul,ol{margin:.4em 0 .8em;padding-left:1.4em}li{margin-bottom:.3em}img{max-width:100%;height:auto}figure{margin:.8em 0}figcaption{font-size:.85em;margin:.3em 0 .8em}.wp-facts{border:1px solid #aaa;padding:.6em;margin:.8em 6px}.wp-fact{margin-bottom:.5em}.wp-facts p{margin-bottom:.4em}.wp-table{margin:.8em 0}.wp-table-row{margin-bottom:.6em}table{margin:.7em 0;width:100%;table-layout:fixed;border-collapse:collapse}th,td{padding:.2em;overflow-wrap:anywhere;word-wrap:break-word}blockquote{margin:.7em .8em}sup{font-size:.75em;vertical-align:super}sub{font-size:.75em;vertical-align:sub}pre{white-space:pre-wrap}code,pre{overflow-wrap:anywhere;word-wrap:break-word}`;

function xhtml(article: Article, title: string, content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(article.language)}" lang="${escapeXml(article.language)}" dir="${article.rtl ? 'rtl' : 'ltr'}"><head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="article.css"/></head><body>${content}</body></html>`;
}

function attribution(article: Article, assets: ImageAsset[]): string {
  return `${article.title} — Wikipedia contributors. Revision ${article.revision}. Retrieved ${new Date().toISOString().slice(0, 10)}. Contributor history: ${article.source}?action=history. Revision: https://${article.language}.wikipedia.org/w/index.php?oldid=${article.revision}. ${article.license.text}: ${article.license.url}. Adapted for offline reading: navigation and references removed, layout simplified, sections split, images resized and made grayscale, equations typeset from MathML. ` + assets.filter(asset => !asset.path.startsWith('equations/')).map(asset => `${asset.title}: ${asset.artist}. ${asset.license}: ${asset.licenseUrl}. Original: ${asset.source}. Image resized and made grayscale.`).join(' ');
}

export function articleFilename(article: Article): string {
  const suffix = ` [${article.language}-${article.pageId}].epub`;
  let title = article.title.normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '') || 'Article';
  const encoder = new TextEncoder();
  while (encoder.encode(title + suffix).length > 100) title = Array.from(title).slice(0, -1).join('');
  return title + suffix;
}

export async function buildEpub(article: Article, includeImages: boolean, signal: AbortSignal, report: Report, equations?: EquationTools): Promise<{ bytes: Uint8Array; filename: string; skippedImages: number }> {
  checkCancelled(signal);
  report('Preparing article…');
  const Zip = await getZip(signal);
  checkCancelled(signal);
  const root = cleanArticle(article, equations);
  const [{ assets, skipped }, formulas] = await Promise.all([
    prepareImages(root, article, includeImages, signal, report),
    equations ? equations.prepare(root, article, signal, report) : [],
  ]);
  assets.push(...formulas);
  checkCancelled(signal);
  const sections = sectionArticle(root);
  if (!sections.length) throw new Error('This article contains no readable content.');
  const title = root.ownerDocument.createElement('h1');
  title.textContent = article.title;
  sections[0].body.prepend(title);
  const zip = new Zip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', createFolders: false });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', { createFolders: false });
  const styles = CSS + '.wp-bold{font-weight:bold}.wp-italic{font-style:italic}.wp-equation{display:block;margin:.6em 0}.wp-inline-math{overflow-wrap:anywhere}';
  zip.file('EPUB/article.css', article.rtl ? styles.replace(/text-align:left/g, 'text-align:right') : styles, { createFolders: false });
  const serializer = new XMLSerializer();
  for (const section of sections) {
    const content = Array.from(section.body.childNodes).map(node => serializer.serializeToString(node)).join('');
    zip.file(`EPUB/${section.file}`, xhtml(article, section.title, content), { createFolders: false });
  }
  for (const asset of assets) zip.file(`EPUB/${asset.path}`, asset.data, { compression: 'STORE', createFolders: false });
  const e = escapeXml;
  const nav = sections.map(section => `<li><a href="${section.file}">${e(section.title)}</a></li>`).join('');
  zip.file('EPUB/nav.xhtml', xhtml(article, 'Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${nav}</ol></nav>`), { createFolders: false });
  const identifier = `urn:wikipedia:${article.language}:${article.pageId}:${article.revision}`;
  zip.file('EPUB/toc.ncx', `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${e(identifier)}"/></head><docTitle><text>${e(article.title)}</text></docTitle><navMap>${sections.map((section, index) => `<navPoint id="nav-${index}" playOrder="${index + 1}"><navLabel><text>${e(section.title)}</text></navLabel><content src="${section.file}"/></navPoint>`).join('')}</navMap></ncx>`, { createFolders: false });
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const manifest = sections.map((section, index) => `<item id="s${index}" href="${section.file}" media-type="application/xhtml+xml"/>`).join('');
  const images = assets.map((asset, index) => `<item id="i${index}" href="${asset.path}" media-type="${asset.mediaType || 'image/jpeg'}"/>`).join('');
  zip.file('EPUB/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${e(article.language)}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${e(identifier)}</dc:identifier><dc:title>${e(article.title)}</dc:title><dc:creator>Wikipedia contributors</dc:creator><dc:language>${e(article.language)}</dc:language><dc:publisher>Wikipedia</dc:publisher><dc:source>${e(article.source)}</dc:source><dc:description>${e(attribution(article, assets))}</dc:description><dc:rights>${e(article.license.text)} — ${e(article.license.url)}</dc:rights><meta property="dcterms:modified">${modified}</meta></metadata><manifest>${manifest}${images}<item id="css" href="article.css" media-type="text/css"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx" page-progression-direction="${article.rtl ? 'rtl' : 'ltr'}">${sections.map((_, index) => `<itemref idref="s${index}"/>`).join('')}</spine></package>`, { createFolders: false });
  report('Packaging EPUB…');
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  checkCancelled(signal);
  return { bytes, filename: articleFilename(article), skippedImages: skipped };
}
