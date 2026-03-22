import { chromium } from 'playwright';

const url = process.argv[2] || 'https://glowing-adventure-ww96647jqrjf7qv-4000.app.github.dev';
const outFile = process.argv[3] || '/tmp/vibe-ui-screenshot.png';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Handle GitHub Codespace auth gate
    const continueBtn = await page.$('button:has-text("Continue")');
    if (continueBtn) {
      console.log('Clicking Continue on auth gate...');
      await continueBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: outFile, fullPage: false });
    console.log(`Screenshot saved to ${outFile}`);
  } catch (err) {
    console.error('Screenshot failed:', err.message);
    // Take screenshot even on error
    await page.screenshot({ path: outFile, fullPage: false });
    console.log(`Error screenshot saved to ${outFile}`);
  } finally {
    await browser.close();
  }
})();
