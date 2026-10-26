// CPFONT v4 interval tables are also used by the reader to locate glyphs.
export function fontFaces(bytes, size) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8, true) !== 4) throw new Error('Unsupported CPFONT version');
  return Array.from({ length: bytes[12] }, (_, style) => {
    const toc = 32 + style * 32;
    const count = view.getUint32(toc + 4, true);
    const offset = view.getUint32(toc + 24, true);
    const ranges = Array.from({ length: count }, (_, index) => [
      view.getUint32(offset + index * 12, true),
      view.getUint32(offset + index * 12 + 4, true),
      view.getUint32(offset + index * 12 + 8, true),
    ]);
    return {
      name: `${size}pt/style${style}`, ranges,
      hasBitmap(cp) {
        const range = ranges.find(([start, end]) => start <= cp && cp <= end);
        if (!range) return false;
        const glyph = offset + count * 12 + (range[2] + cp - range[0]) * 16;
        return view.getUint16(glyph + 8, true) > 0;
      },
    };
  });
}
