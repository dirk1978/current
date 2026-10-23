// Screenshots of each tab at phone size: node tools/shot.mjs [outdir] [tabs...]
import { createRequire } from 'node:module';
import fs from 'node:fs';
// Playwright: `npm install playwright` here, or set PLAYWRIGHT_DIR in .env to a folder that has it
const envText = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const require = createRequire(envText.match(/^PLAYWRIGHT_DIR=(.*)$/m)?.[1] || import.meta.url);
const { chromium } = require('playwright');
const key = envText.match(/^ACCESS_TOKEN=(.*)$/m)[1];
const port = envText.match(/^PORT=(.*)$/m)?.[1] || 8092;
const out = process.argv[2] || '/tmp/current-shots';
const tabs = process.argv.slice(3).length ? process.argv.slice(3) : ['grid', 'home', 'car', 'history'];
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://127.0.0.1:${port}/?key=${key}`);
for (const t of tabs) {
  await page.evaluate((t) => window.CurrentApp.setTab(t), t);
  await page.waitForTimeout(t === 'history' ? 7000 : 3000);
  // reveal every card for the full-page shot
  await page.evaluate(() => document.querySelectorAll('.card.reveal').forEach((c) => c.classList.add('in')));
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${out}/${t}.png`, fullPage: true });
  console.log('shot', t);
}
await browser.close();
