import { writeFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { mockWikipedia, selectArticle, download } from './fixtures';

test('audited bibliography and comma-separated citation appendices leave prose and navigation intact', async ({ page }) => {
  // Acedia, Squanto, Sheshi and Palladian architecture use these appendix headings.
  const excluded = ['General bibliography', 'Notes, references and sources', 'Notes, references, and sources'];
  const retained = ['Selected bibliography', 'Historical sources', 'Textual sources', 'Finding primary sources', 'Notes, references and criticism'];
  await mockWikipedia(page, `<div class="mw-parser-output"><p>KEEP introduction.</p>
    ${excluded.map((heading, i) => `<section><div class="mw-heading"><h2>${heading}</h2></div><p>REMOVE appendix ${i}</p><h3>Details</h3><p>REMOVE nested ${i}</p></section><h2>Body ${i}</h2><p>KEEP body ${i}</p>`).join('')}
    ${retained.map(heading => `<h2>${heading}</h2><p>KEEP ${heading}.</p>`).join('')}
    <h2>History</h2><h3>General bibliography</h3><p>REMOVE subsection</p><h3>Aftermath</h3><p>KEEP aftermath.</p>
    <h2>Further reading</h2><h3>Alchemy further reading</h3><p>REMOVE inherited appendix</p></div>`);
  await page.goto('/files');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const { zip } = await download(page);
  const reading = (await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')))).join('');
  expect(reading).toContain('KEEP aftermath.');
  const nav = await zip.file('EPUB/nav.xhtml')!.async('string');
  expect(reading).not.toContain('REMOVE');
  for (const heading of [...excluded, 'Alchemy further reading']) {
    expect(reading).not.toContain(heading);
    expect(nav).not.toContain(heading);
  }
  for (const heading of [...retained, 'Body 0', 'Body 1', 'Body 2']) {
    expect(reading).toContain(`KEEP ${heading.startsWith('Body') ? heading.toLowerCase() : heading}`);
    expect(nav).toContain(`>${heading}</a>`);
  }
});

test('section filtering defaults on and toggling rebuilds the EPUB with reference lists', async ({ page }) => {
  await mockWikipedia(page, `<div class="mw-parser-output"><p>KEEP prose.<sup class="reference">[1]</sup></p>
    <h2>General bibliography</h2><p>Bibliography entry.</p>
    <h2>Notes, references and sources</h2><div class="mw-references-wrap"><div class="reflist"><ol class="references"><li>Reference entry.<span class="mw-cite-backlink">BACKLINK</span></li></ol></div></div>
    <h2>Further reading</h2><p>Reading entry.</p><h2>See also</h2><p>Related topic.</p>
    <h2>External links</h2><p>External resource.</p><script>UNSAFE SCRIPT</script></div>`);
  await page.goto('/files');
  await selectArticle(page);
  await page.getByLabel('Include optimized images').uncheck();
  const filter = page.getByRole('checkbox', { name: 'Filter reference and related sections' });
  await expect(filter).toBeChecked();
  for (const enabled of [true, false, true]) {
    await filter.setChecked(enabled);
    const { zip, bytes } = await download(page);
    await writeFile(test.info().outputPath(enabled ? 'filtered.epub' : 'unfiltered.epub'), bytes);
    const reading = (await Promise.all(Object.keys(zip.files).filter(name => /section-\d+\.xhtml$/.test(name)).map(name => zip.file(name)!.async('string')))).join('');
    const nav = await zip.file('EPUB/nav.xhtml')!.async('string');
    expect(reading).toContain('KEEP prose.');
    expect(reading).not.toMatch(/UNSAFE SCRIPT|BACKLINK|\[1\]/);
    for (const entry of ['Bibliography entry.', 'Reference entry.', 'Reading entry.', 'Related topic.', 'External resource.']) {
      expect(reading.includes(entry)).toBe(!enabled);
    }
    for (const heading of ['General bibliography', 'Notes, references and sources', 'Further reading', 'See also', 'External links']) {
      expect(nav.includes(`>${heading}</a>`)).toBe(!enabled);
    }
    const metadata = await zip.file('EPUB/content.opf')!.async('string');
    expect(metadata.includes('reference and related sections removed')).toBe(enabled);
  }
  await page.getByRole('button', { name: 'Add multiple articles', exact: true }).click();
  // The same option is shared with batch imports, and survives switching modes.
  await page.getByLabel('Articles', { exact: true }).fill('Maputo');
  await page.getByRole('button', { name: 'Review articles', exact: true }).click();
  await expect(filter).toBeVisible();
  await filter.uncheck();
  await page.getByRole('button', { name: 'Back to single article', exact: true }).click();
  await expect(filter).not.toBeChecked();
});
