// Use real blocks rather than column separators: the reader lays these out even
// with Embedded Style disabled. Process nested infobox tables from the inside out.
function flattenFacts(root: ParentNode, doc: Document): void {
  const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table')).filter(table => table.matches('.infobox') || table.closest('.infobox'));
  for (const table of tables.reverse()) {
    const facts = doc.createElement('div');
    const infobox = table.matches('.infobox');
    facts.className = infobox ? 'wp-facts' : 'wp-table';
    let columns: string[] = [];
    for (const row of Array.from(table.rows)) {
      if (row.closest('table') !== table) continue;
      const cells = Array.from(row.cells);
      if (!cells.length) continue;
      if (cells.every(cell => cell.tagName === 'TH')) {
        if (cells.length > 1 && cells.every(cell => cell.colSpan === 1 && cell.rowSpan === 1)) {
          columns = cells.map(cell => cell.textContent?.trim() || '');
          continue;
        }
        columns = [];
        const heading = doc.createElement('h3');
        heading.textContent = cells.map(cell => cell.textContent?.trim()).join(' / ');
        facts.append(heading);
        continue;
      }
      const label = cells.length > 1 && cells[0].tagName === 'TH' ? cells.shift() : undefined;
      cells.forEach((cell, index) => {
        const line = doc.createElement('div');
        line.className = 'wp-fact';
        const column = cells.length === columns.length && cells.every(cell => cell.colSpan === 1 && cell.rowSpan === 1) ? columns[index] : '';
        const name = [label?.textContent?.trim(), column].filter(Boolean).join(' — ');
        if (name) {
          const paragraph = doc.createElement('p');
          const bold = doc.createElement('strong');
          bold.textContent = name;
          paragraph.append(bold);
          line.append(paragraph);
        }
        const value = doc.createElement('div');
        value.append(...cell.childNodes);
        line.append(value);
        facts.append(line);
      });
    }
    // An image-ending box can lose its trailing spacing on the reader.
    const next = table.nextElementSibling;
    if (infobox && next?.tagName === 'P') next.prepend(doc.createElement('br'));
    table.replaceWith(facts);
  }
}

function simplifyTables(root: DocumentFragment, doc: Document): void {
  for (const table of root.querySelectorAll<HTMLTableElement>('table')) {
    if (!root.contains(table) || table.matches('.infobox')) continue;
    const rows = Array.from(table.rows).filter(row => row.closest('table') === table);
    const first = rows[0];
    const title = first?.cells.length === 1 && first.cells[0].tagName === 'TH' && first.cells[0].colSpan > 1 && !first.cells[0].querySelector('table') ? first : undefined;
    const grid = title ? rows.slice(1) : rows;
    const cells = grid.flatMap(row => Array.from(row.cells));
    const width = grid[0]?.cells.length || 0;
    const headers = Array.from(grid[0]?.cells || []);
    const hasHeader = headers.length > 0 && headers.every(cell => cell.tagName === 'TH' && cell.textContent?.trim());
    const codeTable = width > 1 && !!table.querySelector('pre');
    // Merged/nested cells need positional interpretation. Wide grids can only
    // become labeled rows when one header describes each rectangular column.
    const complex = !!table.querySelector('table') || cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1) ||
      grid.some(row => row.cells.length !== width) ||
      (codeTable && !hasHeader) ||
      (width > 3 && (grid.length < 2 || !hasHeader || grid.slice(1).some(row => Array.from(row.cells).every(cell => cell.tagName === 'TH'))));
    if (!complex && width <= 3 && !codeTable) continue;
    const block = doc.createElement('div');
    block.className = 'wp-table';
    const captions = complex ? Array.from(table.querySelectorAll('caption')) : table.caption ? [table.caption] : [];
    const titles = [title, ...captions].map(node => node?.textContent?.trim()).filter((text): text is string => !!text);
    for (const text of new Set(titles)) {
      const heading = doc.createElement('h3');
      heading.textContent = text;
      block.append(heading);
    }
    if (complex) {
      const notice = doc.createElement('p');
      notice.textContent = 'A complex table was omitted from this edition.';
      block.append(notice);
    } else {
      for (const row of grid.slice(1)) {
        const line = doc.createElement('div');
        line.className = 'wp-table-row';
        Array.from(row.cells).forEach((cell, index) => {
          const field = doc.createElement('div');
          const label = doc.createElement('strong');
          label.textContent = `${headers[index].textContent?.trim()}: `;
          field.append(label);
          for (const child of cell.childNodes) field.append(child.cloneNode(true));
          line.append(field);
        });
        block.append(line);
      }
    }
    table.replaceWith(block);
  }
}

// Ordinary tables and infoboxes have different semantics; resolve ambiguous
// grids before turning the surviving infobox rows into explicit facts.
export function normalizeTables(root: DocumentFragment, doc: Document): void {
  simplifyTables(root, doc);
  flattenFacts(root, doc);
}
