import { test, expect } from '@playwright/test';
import { mockWikipedia, selectArticle } from './fixtures';

// The reader's File Manager applies this mobile rule to the plugin's card.
async function readerCardStyles(page: import('@playwright/test').Page) {
  await page.addStyleTag({ content: '@media(max-width:600px){.card{line-break:anywhere;padding:12px}}' });
}

test('mobile help, preview and font text wrap at word boundaries under reader card styles', async ({ page }) => {
  await mockWikipedia(page);
  await page.goto('/files');
  await readerCardStyles(page);
  await selectArticle(page);
  await page.getByText('Optional reader font', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install Inter', exact: true })).toBeVisible();
  for (const width of [320, 390, 480]) {
    await page.setViewportSize({ width, height: 844 });
    const splitWords = await page.evaluate(() => {
      const splits: string[] = [];
      for (const paragraph of document.querySelectorAll('.cp-wikipedia p')) {
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          for (const word of (text.textContent || '').matchAll(/[A-Za-z]{3,}/g)) {
            const range = document.createRange();
            range.setStart(text, word.index!);
            range.setEnd(text, word.index! + word[0].length);
            const lines = new Set([...range.getClientRects()].map(rect => Math.round(rect.top)));
            if (lines.size > 1) splits.push(word[0]);
          }
        }
      }
      return splits;
    });
    expect(splitWords, `Words split inside a ${width}px viewport`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 390 && test.info().project.name === 'chromium') {
      await page.screenshot({ path: '.context/word-wrap-mobile.png', fullPage: true });
    }
  }
});

test('font installation feedback stays with font controls and article feedback returns to article actions', async ({ page }) => {
  await mockWikipedia(page);
  await page.route('**/api/fonts', route => route.fulfill({ status: 404 }));
  await page.goto('/files');
  await page.getByText('Optional reader font', { exact: true }).click();
  await page.getByRole('button', { name: 'Install Inter', exact: true }).click();
  const status = page.getByRole('status');
  await expect(status).toContainText('Font setup failed.');
  expect((await status.boundingBox())!.y).toBeGreaterThan((await page.getByRole('button', { name: 'Install Inter', exact: true }).boundingBox())!.y);
  await page.getByText('Optional reader font', { exact: true }).click();
  await expect(status).toBeVisible();
  await selectArticle(page);
  expect((await status.boundingBox())!.y).toBeLessThan((await page.locator('.wp-fonts').boundingBox())!.y);
  await expect(page.getByRole('status')).toHaveText('Ready to import.');
});
