import { createHash } from 'node:crypto';
import JSZip from 'jszip';

// Compare book contents instead of ZIP timestamps or compression output. Keep
// every entry, its order, and metadata other than a valid generated modified date.
export async function epubFingerprint(bytes) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const hash = createHash('sha256');
  // EPUB requires the first local entry to be the uncompressed mimetype. Keep
  // its header in the fingerprint so container errors cannot match a valid book.
  const firstHeader = Buffer.from(bytes.subarray(0, 30));
  firstHeader.fill(0, 10, 14); // ZIP modification time/date only.
  hash.update(firstHeader).update(JSON.stringify(zip.comment));
  for (const entry of Object.values(zip.files)) {
    let content = await entry.async('nodebuffer');
    if (entry.name.endsWith('.opf')) {
      const text = content.toString('utf8');
      // Do not normalize malformed UTF-8, XML, or invalid timestamps away.
      if (Buffer.from(text).equals(content)) {
        content = Buffer.from(text.replace(/(<meta property="dcterms:modified">)(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(<\/meta>)/g,
          (match, open, date, close) => {
            const parsed = new Date(date);
            return Number.isFinite(parsed.valueOf()) && parsed.toISOString().replace('.000Z', 'Z') === date
              ? `${open}2000-01-01T00:00:00Z${close}` : match;
          }));
      }
    }
    hash.update(JSON.stringify([entry.name, entry.unsafeOriginalName, entry.dir, entry.comment, entry.unixPermissions, entry.dosPermissions, content.length]));
    hash.update(content);
  }
  return hash.digest('hex');
}
