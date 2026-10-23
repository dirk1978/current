// Screenshots of single History cards for a range: node tools/shot-cards.mjs <range> <outdir> <#id>...
import { createRequire } from 'node:module';
import fs from 'node:fs';
// Playwright: `npm install playwright` here, or set PLAYWRIGHT_DIR in .env to a folder that has it
const envText = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const require = createRequire(envText.match(/^PLAYWRIGHT_DIR=(.*)$/m)?.[1] || import.meta.url);
const { chromium } = require('playwright');
const key = envText.match(/^ACCESS_TOKEN=(.*)$/m)[1];
const port = envText.match(/^PORT=(.*)$/m)?.[1] || 8092;
const [range, out, ...ids] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${port}/?key=${key}`);
await page.evaluate((r) => { localStorage.setItem('range', r); }, range);
await page.reload();
await page.evaluate(() => window.CurrentApp.setTab('history'));
await page.waitForTimeout(6000);
await page.evaluate(() => document.querySelectorAll('.card.reveal').forEach((c) => c.classList.add('in')));
await page.waitForTimeout(1800);
for (const id of ids) {
  await page.locator(id).locator('xpath=ancestor::div[contains(@class,"card")][1]').screenshot({ path: `${out}/${range}-${id.slice(1)}.png` });
  console.log('shot', range, id);
}
await browser.close();
