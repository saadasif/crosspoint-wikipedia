import { type Section } from './types';

const SECTION_LIMIT = 24000;
const encoder = new TextEncoder();
const serializer = new XMLSerializer();

function serializedBytes(node: Node): number {
  return encoder.encode(serializer.serializeToString(node)).length;
}

function* boundedNodes(node: Node, limit = SECTION_LIMIT - 256): Generator<Node> {
  const size = serializedBytes(node);
  if (size <= limit) { yield node; return; }
  if (node instanceof Element) {
    const children = Array.from(node.childNodes);
    let group = node.cloneNode(false) as HTMLElement;
    const overhead = serializedBytes(group) + 64;
    let used = overhead;
    let ordinal = Number(node.getAttribute('start')) || 1;
    for (const child of children) {
      for (const part of boundedNodes(child, Math.max(128, limit - overhead))) {
        const bytes = serializedBytes(part);
        if (group.childNodes.length && used + bytes > limit) {
          yield group;
          group = node.cloneNode(false) as HTMLElement;
          group.removeAttribute('id');
          if (node.tagName === 'OL') group.setAttribute('start', String(ordinal));
          used = overhead;
        }
        group.append(part);
        used += bytes;
      }
      if (child instanceof Element && child.tagName === 'LI') ordinal = Number(child.getAttribute('value') || ordinal) + 1;
    }
    if (group.childNodes.length) yield group;
    return;
  }
  const points = Array.from(node.textContent || '');
  const chunk = Math.max(1, Math.floor(limit / 6));
  for (let start = 0; start < points.length; start += chunk) {
    yield node.ownerDocument!.createTextNode(points.slice(start, start + chunk).join(''));
  }
}

// MediaWiki editions may wrap each section in structural containers. Expose
// their headings to navigation while keeping facts, figures and lists intact.
function* sectionBlocks(root: HTMLElement): Generator<Node> {
  for (const node of Array.from(root.childNodes)) {
    if (node instanceof HTMLElement && node.matches('div,section,article') && node.querySelector('h2')) {
      for (const part of sectionBlocks(node)) {
        if (part instanceof HTMLElement && node.hasAttribute('dir') && !part.hasAttribute('dir')) {
          part.setAttribute('dir', node.getAttribute('dir')!);
        }
        yield part;
      }
    } else yield node;
  }
}

export function sectionArticle(root: HTMLElement): Section[] {
  const sections: Section[] = [];
  let title = 'Introduction';
  let size = 0;
  let current: Section | undefined;
  for (const original of sectionBlocks(root)) {
    for (const node of boundedNodes(original)) {
      if (!node.textContent?.trim() && !(node instanceof Element && (node.tagName === 'IMG' || node.querySelector('img')))) continue;
      const length = serializedBytes(node);
      const heading = node instanceof Element && node.tagName === 'H2';
      if (heading) title = node.textContent || 'Section';
      if (!current || heading || size + length > SECTION_LIMIT) {
        current = { title: heading || !current ? title : `${title} (continued)`, file: `section-${sections.length + 1}.xhtml`, body: root.ownerDocument.createElement('div') };
        sections.push(current);
        size = 0;
      }
      current.body.append(node);
      size += length;
    }
  }
  return sections;
}
