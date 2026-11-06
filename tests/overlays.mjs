/**
 * Overlays stay above the map, the sketch canvas, and the sticky bars.
 * Run: node tests/overlays.mjs
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';

const CHROME = process.env.CHROME || '/usr/local/bin/google-chrome';
const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ART = process.env.SHOTS || '/opt/cursor/artifacts';
const VIEWS = [[1376, 1032], [1440, 900], [1100, 900], [390, 844]];

const fail = (msg) => { throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

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

async function boot(browser, w, h) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main [data-go="new"]');
  await page.waitForFunction(() => {
    const q = S.quotes.find((x) => x.demo);
    return !q || q.examplePhotosSeeded;
  });
  return { page, errors };
}

async function clickSel(page, sel) {
  await page.waitForSelector(sel);
  await page.evaluate((sel) => document.querySelector(sel).click(), sel);
}

function record(overlay, screen, w, h, ok, detail) {
  results.push({ overlay, screen, viewport: `${w}x${h}`, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}\t${overlay}\t${screen}\t${w}x${h}${detail ? '\t' + detail : ''}`);
}

async function probe(page, rootSel) {
  return page.evaluate((rootSel) => {
    document.querySelectorAll('.toast').forEach((el) => el.remove());
    const root = document.querySelector(rootSel);
    if (!root) return { missing: true, bad: ['overlay missing'], focused: false, blocked: [] };
    const sheet = root.querySelector('.sheet') || root;
    const sr = sheet.getBoundingClientRect();
    const points = [];
    [0.25, 0.5, 0.75].forEach((fy) => {
      [0.2, 0.5, 0.8].forEach((fx) => {
        points.push({ x: sr.left + sr.width * fx, y: sr.top + sr.height * fy, where: 'dialog', want: 'inside' });
      });
    });
    const addBox = (sel, where) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
      points.push({ x: Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2), y: Math.min(Math.max(r.top + Math.min(r.height / 2, 30), 1), innerHeight - 2), where, want: 'covered' });
    };
    addBox('.leaflet-container', 'map');
    addBox('.skarea canvas', 'sketch');
    addBox('header.top', 'header');
    addBox('.stbanner', 'banner');
    addBox('.bar', 'totals');
    addBox('nav.tabs', 'tabs');
    const bad = [];
    const covered = [];
    for (const p of points) {
      if (p.x < 0 || p.y < 0 || p.x > innerWidth || p.y > innerHeight) continue;
      const el = document.elementFromPoint(p.x, p.y);
      const inside = !!(el && root.contains(el));
      if (!inside) bad.push(p.where + ' hit ' + (el ? (el.tagName + '.' + String(el.className).slice(0, 40)) : 'nothing'));
      else if (p.want === 'covered') covered.push(p.where);
    }
    const blockers = ['.leaflet-container', '.skarea canvas'];
    const leaked = [];
    blockers.forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.bottom < 0 || r.top > innerHeight) return;
      let got = false;
      const fn = () => { got = true; };
      el.addEventListener('pointerdown', fn, true);
      const x = r.left + r.width / 2;
      const y = Math.min(Math.max(r.top + 24, 1), innerHeight - 2);
      const top = document.elementFromPoint(x, y);
      if (top) top.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      el.removeEventListener('pointerdown', fn, true);
      if (got || (top && el.contains(top))) leaked.push(sel);
    });
    const focusEl = document.activeElement;
    return {
      missing: false,
      bad,
      covered: [...new Set(covered)],
      leaked,
      focused: !!(focusEl && root.contains(focusEl))
    };
  }, rootSel);
}

async function checkOverlay(page, overlay, screen, w, h, rootSel, shot) {
  const hit = await probe(page, rootSel);
  const ok = !hit.missing && hit.bad.length === 0 && hit.leaked.length === 0 && hit.focused;
  const detail = ok ? '' : JSON.stringify({ bad: hit.bad, leaked: hit.leaked, focused: hit.focused, covered: hit.covered });
  record(overlay, screen, w, h, ok, detail);
  if (ok && shot) await page.screenshot({ path: shot });
  return ok;
}

async function closeTop(page) {
  await page.keyboard.press('Escape');
  await sleep(50);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
});
const server = await ensureServer();

try {
  for (const [w, h] of VIEWS) {
    const { page, errors } = await boot(browser, w, h);
    const shot = (name) => w === 1376 ? `${ART}/overlay-${name}-ipad-1376x1032.png` : '';
    await clickSel(page, 'main [data-go="new"]');
    await page.waitForSelector('.leaflet-container');
    await page.evaluate(() => document.querySelector('.sitemap').scrollIntoView({ block: 'center' }));

    await clickSel(page, '[data-addunit]');
    await page.waitForSelector('.modal .sheet');
    await checkOverlay(page, 'Add unit', 'Customer (map)', w, h, '.modal', shot('add-unit-map'));
    await closeTop(page);
    await page.waitForFunction(() => !document.querySelector('.modal'));

    await page.evaluate(() => {
      document.querySelector('#siteq').scrollIntoView({ block: 'start' });
      GEO.showResults([{ display_name: '1 Example St, Adelaide, South Australia, 5000, Australia', lat: '-34.93', lon: '138.60', address: { house_number: '1', road: 'Example St', city: 'Adelaide', state: 'South Australia', postcode: '5000' } }]);
    });
    await page.waitForSelector('#siteul li');
    const sug = await page.evaluate(() => {
      const li = document.querySelector('#siteul li');
      const r = li.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + 16, 2), innerWidth - 2);
      const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 22), 2), innerHeight - 2);
      const el = document.elementFromPoint(x, y);
      const map = document.querySelector('.leaflet-container');
      const visible = r.bottom > 0 && r.top < innerHeight && r.height > 8;
      return { hitList: visible && !!(el && li.contains(el)), underMap: !!(el && map && map.contains(el)), what: el ? el.tagName + '.' + String(el.className).slice(0, 30) : 'none', y, top: r.top, h: r.height };
    });
    record('Address results', 'Customer (map)', w, h, sug.hitList && !sug.underMap, sug.hitList && !sug.underMap ? '' : JSON.stringify(sug));
    if (w === 1376 && sug.hitList) await page.screenshot({ path: shot('address-results') });
    await closeTop(page);
    await page.waitForFunction(() => document.getElementById('siteul').hidden);

    await page.evaluate(() => toast('Layer check'));
    await page.waitForSelector('.toast');
    const toastHit = await page.evaluate(() => {
      const t = document.querySelector('.toast');
      const r = t.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const tz = getComputedStyle(t).zIndex;
      const mz = getComputedStyle(document.querySelector('.sitemap')).zIndex;
      return { onToast: !!(el && (el === t || t.contains(el))), tz, mz };
    });
    record('Toast', 'Customer (map)', w, h, toastHit.onToast && Number(toastHit.tz) > Number(toastHit.mz), toastHit.onToast ? '' : JSON.stringify(toastHit));
    if (w === 1376 && toastHit.onToast) await page.screenshot({ path: shot('toast-map') });
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((el) => el.remove()));

    await page.evaluate(() => document.querySelector('[data-rmunit]').click());
    await page.waitForSelector('.modal .sheet');
    await checkOverlay(page, 'Remove unit', 'Customer (map)', w, h, '.modal', shot('remove-unit-map'));
    await closeTop(page);
    await page.waitForFunction(() => !document.querySelector('.modal'));

    await clickSel(page, '[data-step="1"]');
    await page.waitForSelector('.skarea canvas');
    await clickSel(page, '[data-addunit]');
    await page.waitForSelector('.modal .sheet');
    await checkOverlay(page, 'Add unit', 'Sketch (canvas)', w, h, '.modal', shot('add-unit-sketch'));
    await closeTop(page);
    await page.waitForFunction(() => !document.querySelector('.modal'));
    await page.evaluate(() => toast('Sketch layer check'));
    await page.waitForSelector('.toast');
    const toastSk = await page.evaluate(() => {
      const t = document.querySelector('.toast');
      const r = t.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(el && t.contains(el));
    });
    record('Toast', 'Sketch (canvas)', w, h, toastSk, toastSk ? '' : 'toast not hit');
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((el) => el.remove()));

    await clickSel(page, '[data-step="2"]');
    await page.waitForSelector('[data-addunit]');
    await clickSel(page, '[data-addunit]');
    await page.waitForSelector('.modal .sheet');
    await checkOverlay(page, 'Add unit', 'Room', w, h, '.modal', '');
    await closeTop(page);
    await clickSel(page, '[data-rmunit]');
    await page.waitForSelector('.modal .sheet');
    await checkOverlay(page, 'Remove unit', 'Room', w, h, '.modal', '');
    await closeTop(page);

    await clickSel(page, '[data-step="3"]');
    await page.waitForSelector('[data-phfile][multiple]');
    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 80; c.height = 48;
      c.getContext('2d').fillRect(0, 0, 80, 48);
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      const file = new File([blob], 'survey.png', { type: 'image/png' });
      const input = document.querySelector('[data-phsec][multiple]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForSelector('[data-phopen]');
    await clickSel(page, '[data-phopen]');
    await page.waitForSelector('.lightbox:not([hidden]) [data-lbclose]');
    await checkOverlay(page, 'Photo viewer', 'Site survey', w, h, '.lightbox', '');
    await closeTop(page);
    await page.waitForFunction(() => document.querySelector('.lightbox').hidden);
    await clickSel(page, '[data-phdel]');
    await page.waitForSelector('.modal .sheet');
    await checkOverlay(page, 'Delete photo', 'Site survey', w, h, '.modal', '');
    await closeTop(page);

    await clickSel(page, '[data-step="7"]');
    await page.waitForSelector('[data-phopen]');
    await clickSel(page, '[data-phopen]');
    await page.waitForSelector('.lightbox:not([hidden]) [data-lbclose]');
    await checkOverlay(page, 'Photo viewer', 'Photos', w, h, '.lightbox', shot('photo-viewer'));
    await clickSel(page, '[data-lbmark]');
    await page.waitForSelector('.lightbox canvas');
    await checkOverlay(page, 'Photo markup', 'Photos', w, h, '.lightbox', shot('photo-markup'));
    await closeTop(page);
    await page.waitForFunction(() => !document.querySelector('.lightbox canvas'));
    const still = await page.evaluate(() => !document.querySelector('.lightbox').hidden && LB.mode === 'view');
    record('Photo markup Escape', 'Photos', w, h, still, still ? '' : 'Escape did not leave the editor open as the viewer');
    await closeTop(page);
    await page.waitForFunction(() => document.querySelector('.lightbox').hidden);
    await clickSel(page, '[data-phdel]');
    await page.waitForSelector('.modal .sheet');
    await checkOverlay(page, 'Delete photo', 'Photos', w, h, '.modal', shot('delete-photo'));
    await closeTop(page);

    await clickSel(page, '[data-step="8"]');
    await page.waitForSelector('[data-preview]');
    await clickSel(page, '[data-preview]');
    await page.waitForSelector('[data-send]');
    await clickSel(page, '[data-send]');
    await page.waitForSelector('.modal .sheet');
    await checkOverlay(page, 'Send quote', 'Preview', w, h, '.modal', shot('send-quote'));
    await closeTop(page);
    await page.waitForFunction(() => !document.querySelector('.modal'));

    if (errors.length) record('Page errors', 'all', w, h, false, errors.join(' | '));
    await page.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\nOVERLAY\tSCREEN\tVIEWPORT\tRESULT');
  for (const r of results) console.log(`${r.overlay}\t${r.screen}\t${r.viewport}\t${r.ok ? 'pass' : 'fail'}`);
  console.log('\nNot overlays: labour type editors are inline fields on Labour & GST. Print opens the browser print dialog, not an in-app sheet.');
  if (failed.length) fail(failed.length + ' overlay checks failed');
  console.log('OVERLAYS PASSED');
} finally {
  await browser.close();
  if (server) server.kill();
}
