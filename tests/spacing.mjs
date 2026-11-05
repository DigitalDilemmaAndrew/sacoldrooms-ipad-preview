/**
 * Spacing: action rows must not touch the next card, and pages must not overflow.
 * Run: node tests/spacing.mjs
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';

const CHROME = process.env.CHROME || '/usr/local/bin/google-chrome';
const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ART = process.env.SHOTS || '/opt/cursor/artifacts';
const VIEWS = [[1376, 1032], [1440, 900], [1100, 900], [390, 844], [480, 800]];

const fail = (msg) => { throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const child = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    if (await portOpen(PORT)) return child;
    await sleep(100);
  }
  child.kill();
  fail('local server did not start');
}

function gapScript() {
  const btn = document.querySelector('main [data-go="new"]');
  const next = btn.closest('.row').nextElementSibling;
  const br = btn.getBoundingClientRect();
  const nr = next.getBoundingClientRect();
  const header = document.querySelector('header.top').getBoundingClientRect();
  const title = document.querySelector('main h1').getBoundingClientRect();
  const fresh = document.querySelector('main [data-fresh]').getBoundingClientRect();
  return {
    gap: nr.top - br.bottom,
    btnH: br.height,
    freshH: fresh.height,
    titleClear: title.top - header.bottom,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    freshText: document.querySelector('main [data-fresh]').innerText.trim(),
    freshClip: document.querySelector('main [data-fresh]').scrollWidth > document.querySelector('main [data-fresh]').clientWidth + 1
  };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
});
const server = await ensureServer();

try {
  for (const [w, h] of VIEWS) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main [data-go="new"]');
    const dash = await page.evaluate(gapScript);
    if (dash.gap < 16) fail(`${w}x${h} dashboard action/card gap is ${dash.gap}px`);
    if (dash.btnH < 44 || dash.freshH < 44) fail(`${w}x${h} header buttons under 44px`);
    if (dash.freshClip || !dash.freshText.includes('Start fresh')) fail(`${w}x${h} Start fresh label clipped`);
    if (dash.overflow) fail(`${w}x${h} dashboard overflows`);
    if (dash.titleClear < 8) fail(`${w}x${h} sticky header covers the title (${dash.titleClear})`);
    if (w === 1376) {
      await page.screenshot({ path: `${ART}/after-spacing-dashboard-ipad-1376x1032.png` });
      const b = await (await page.$('main [data-go="new"]')).boundingBox();
      await page.screenshot({
        path: `${ART}/after-spacing-dashboard-crop-ipad.png`,
        clip: { x: Math.max(0, b.x - 420), y: Math.max(0, b.y - 36), width: Math.min(900, w - 8), height: 280 }
      });
    }
    console.log('dashboard', w, 'gap', Math.round(dash.gap));

    await page.$eval('main [data-go="new"]', (el) => el.click());
    await page.waitForSelector('#sitesearch');
    const form = await page.evaluate(() => {
      const card = document.querySelector('main .card');
      const pad = parseFloat(getComputedStyle(card).paddingTop);
      const email = document.querySelector('[data-q="email"]');
      const site = document.querySelector('.addrlab');
      const gap = site.getBoundingClientRect().top - email.getBoundingClientRect().bottom;
      const search = document.getElementById('sitesearch');
      const header = document.querySelector('header.top').getBoundingClientRect();
      const title = document.querySelector('main h1').getBoundingClientRect();
      return {
        pad,
        fieldGap: gap,
        searchH: search.getBoundingClientRect().height,
        searchClip: search.scrollWidth > search.clientWidth + 1,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        titleClear: title.top - header.bottom
      };
    });
    if (form.pad < 16) fail(`${w}x${h} card padding ${form.pad}`);
    if (form.fieldGap < 8) fail(`${w}x${h} field stack gap ${form.fieldGap}`);
    if (form.searchH < 44 || form.searchClip) fail(`${w}x${h} Search crowded or clipped`);
    if (form.overflow) fail(`${w}x${h} customer form overflows`);
    if (form.titleClear < 8) fail(`${w}x${h} sticky header covers the quote title`);
    if (w === 1376) await page.screenshot({ path: `${ART}/after-spacing-customer-ipad-1376x1032.png` });
    if (w === 390) await page.screenshot({ path: `${ART}/after-spacing-customer-phone-390x844.png` });
    console.log('customer', w, 'pad', form.pad, 'fieldGap', Math.round(form.fieldGap));
    await page.close();
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1376, height: 1032, deviceScaleFactor: 1 });
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main [data-go="new"]');
  await page.$eval('main [data-go="new"]', (el) => el.click());
  await page.waitForSelector('[data-step="1"]');
  await page.$eval('[data-step="1"]', (el) => el.click());
  await page.waitForSelector('.sktools');
  const sketch = await page.evaluate(() => {
    const tools = document.querySelector('.sktools');
    const canvas = document.querySelector('.skarea');
    const gap = canvas.getBoundingClientRect().top - tools.getBoundingClientRect().bottom;
    return {
      gap,
      toolH: tools.querySelector('button').getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  });
  if (sketch.gap < 0) fail('sketch toolbar overlaps the canvas');
  if (sketch.toolH < 44) fail('sketch tool under 44px');
  if (sketch.overflow) fail('sketch overflows');
  await page.screenshot({ path: `${ART}/after-spacing-sketch-ipad-1376x1032.png` });
  await page.$eval('[data-go="prices"]', (el) => el.click());
  await page.waitForSelector('main h1');
  const prices = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    h1: document.querySelector('main h1').getBoundingClientRect().height
  }));
  if (prices.overflow) fail('price list overflows');
  await page.screenshot({ path: `${ART}/after-spacing-prices-ipad-1376x1032.png` });
  console.log('sketch gap', Math.round(sketch.gap), 'prices ok');
  await page.close();
  console.log('SPACING PASSED');
} finally {
  await browser.close();
  if (server) server.kill();
}
