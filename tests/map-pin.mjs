/**
 * Fixed centre pin: pan the map, reverse-geocode once after it settles.
 * Run: node tests/map-pin.mjs
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';

const CHROME = process.env.CHROME || '/usr/local/bin/google-chrome';
const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ART = process.env.SHOTS || '/opt/cursor/artifacts';

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

function nominatimBody(road, suburb, postcode) {
  return JSON.stringify({
    lat: '-34.92',
    lon: '138.62',
    address: { house_number: '9', road, suburb, state: 'South Australia', postcode }
  });
}

function attachNominatim(page, delays) {
  const hit = { reverse: [], search: 0 };
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('nominatim.openstreetmap.org/reverse')) {
      const id = hit.reverse.length + 1;
      hit.reverse.push(Date.now());
      const road = id === 1 ? 'First Road' : 'Second Road';
      const suburb = id === 1 ? 'Norwood' : 'Unley';
      const postcode = id === 1 ? '5067' : '5061';
      const wait = delays[id - 1] ?? 20;
      setTimeout(() => {
        req.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
          body: nominatimBody(road, suburb, postcode)
        }).catch(() => {});
      }, wait);
      return;
    }
    if (url.includes('nominatim.openstreetmap.org/search')) {
      hit.search += 1;
      req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          display_name: '12 Search Street, Adelaide, South Australia, 5000',
          lat: '-34.93000',
          lon: '138.61000',
          address: { house_number: '12', road: 'Search Street', suburb: 'Adelaide', state: 'South Australia', postcode: '5000' }
        }])
      }).catch(() => {});
      return;
    }
    req.continue().catch(() => {});
  });
  return hit;
}

async function openCustomer(page) {
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-go="new"]');
  await page.$eval('[data-go="new"]', (el) => el.click());
  await page.waitForSelector('.leaflet-container');
  await page.waitForSelector('.centrepin');
}

async function dragMap(page, dx, dy) {
  return page.evaluate((dx, dy) => {
    const el = document.querySelector('#mapcanvas');
    const pane = document.querySelector('.leaflet-map-pane');
    const before = pane ? getComputedStyle(pane).transform : '';
    const r = el.getBoundingClientRect();
    const start = [r.left + r.width / 2, r.top + r.height / 2];
    const end = [start[0] + dx, start[1] + dy];
    const fire = (type, x, y) => {
      const target = document.elementFromPoint(x, y) || el;
      const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [touch],
        targetTouches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch]
      }));
    };
    fire('touchstart', start[0], start[1]);
    for (let i = 1; i <= 6; i++) fire('touchmove', start[0] + (end[0] - start[0]) * i / 6, start[1] + (end[1] - start[1]) * i / 6);
    fire('touchend', end[0], end[1]);
    return { before, after: pane ? getComputedStyle(pane).transform : '', w: r.width, h: r.height };
  }, dx, dy);
}

async function quotePin(page) {
  return page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('sacr-ipad-v1'));
    const q = raw.quotes.find((item) => !item.demo);
    return {
      lat: q.lat, lng: q.lng, street: q.street, suburb: q.suburb, state: q.state, postcode: q.postcode,
      field: document.querySelector('[data-q="street"]').value,
      status: document.getElementById('geostatus').textContent
    };
  });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
});
const server = await ensureServer();
const context = browser.defaultBrowserContext();
await context.overridePermissions(ORIGIN, ['geolocation']);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1376, height: 1032, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  await page.setGeolocation({ latitude: -34.91, longitude: 138.62 });
  const hit = attachNominatim(page, [40, 30]);
  await openCustomer(page);

  const hint = await page.$eval('.maphint', (el) => el.textContent.trim());
  if (hint !== 'Move map to position the pin') fail('instruction is "' + hint + '"');
  const pinEvents = await page.$eval('.centrepin', (el) => getComputedStyle(el).pointerEvents);
  if (pinEvents !== 'none') fail('centre pin intercepts the finger');
  await page.screenshot({ path: `${ART}/after-map-pin-ipad-1376x1032.png` });
  const map = await page.$('#sitemape');
  const mapBox = await map.boundingBox();
  await page.screenshot({
    path: `${ART}/after-map-pin-crop-ipad-1376x1032.png`,
    clip: { x: mapBox.x, y: mapBox.y, width: mapBox.width, height: mapBox.height }
  });

  await sleep(700);
  if (hit.reverse.length !== 0) fail('reverse fired before a pan (' + hit.reverse.length + ')');

  const before = await quotePin(page);
  await dragMap(page, -80, 40);
  await sleep(120);
  if (hit.reverse.length !== 0) fail('reverse fired during the drag, before the map settled');
  await page.waitForFunction(() => document.querySelector('[data-q="street"]').value.includes('First Road'), { timeout: 4000 });
  if (hit.reverse.length !== 1) fail('expected one reverse after settle, got ' + hit.reverse.length);
  const after = await quotePin(page);
  if (after.lat == null || after.lng == null) fail('pin coordinates were not saved');
  if (before.lat === after.lat && before.lng === after.lng) fail('drag did not change coordinates');
  if (after.suburb !== 'Norwood' || after.state !== 'SA' || after.postcode !== '5067') fail('address fields ' + JSON.stringify(after));
  if (!after.field.includes('First Road')) fail('street field not filled');
  await sleep(800);
  if (hit.reverse.length !== 1) fail('settled pan fired again (' + hit.reverse.length + ')');
  console.log('one reverse after drag', after.lat, after.lng, after.field);

  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1376, height: 1032, deviceScaleFactor: 1 });
  await page2.setRequestInterception(true);
  const stale = attachNominatim(page2, [1200, 40]);
  await openCustomer(page2);
  const moved = await dragMap(page2, -70, 30);
  const started = Date.now();
  while (stale.reverse.length < 1 && Date.now() - started < 3000) await sleep(50);
  if (stale.reverse.length < 1) {
    const status = await page2.$eval('#geostatus', (el) => el.textContent);
    const resources = await page2.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('nominatim')));
    fail('first reverse never started ' + JSON.stringify(moved) + ' status=' + status + ' net=' + resources.join('|'));
  }
  await dragMap(page2, 60, -25);
  await page2.waitForFunction(() => document.querySelector('[data-q="street"]').value.includes('Second Road'), { timeout: 5000 });
  await sleep(1500);
  const won = await quotePin(page2);
  if (!won.field.includes('Second Road') || won.suburb !== 'Unley') fail('stale reverse overwrote the newer pin: ' + JSON.stringify(won));
  if (stale.reverse.length !== 2) fail('reverse flood or missing second lookup: ' + stale.reverse.length);
  console.log('latest reverse kept', won.field, 'calls', stale.reverse.length);

  const page3 = await browser.newPage();
  await page3.setViewport({ width: 1376, height: 1032, deviceScaleFactor: 1 });
  await page3.setRequestInterception(true);
  await page3.setGeolocation({ latitude: -34.91, longitude: 138.62 });
  const both = attachNominatim(page3, [30]);
  await openCustomer(page3);
  await page3.$eval('#siteq', (el) => { el.value = '12 Search Street Adelaide'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page3.$eval('#sitesearch', (el) => el.click());
  await page3.waitForSelector('[data-sug]');
  await page3.$eval('[data-sug]', (el) => el.click());
  await page3.waitForFunction(() => document.querySelector('[data-q="street"]').value.includes('Search Street'));
  const searched = await quotePin(page3);
  if (searched.suburb !== 'Adelaide' || searched.postcode !== '5000') fail('search did not fill the address ' + JSON.stringify(searched));
  await sleep(1200);
  if (both.reverse.length !== 0) fail('search recenter started a reverse loop (' + both.reverse.length + ')');
  if (both.search !== 1) fail('search count ' + both.search);
  const locateBefore = both.reverse.length;
  await page3.$eval('#sitepin', (el) => el.click());
  await page3.waitForFunction(() => document.querySelector('[data-q="street"]').value.includes('First Road'), { timeout: 4000 });
  const located = await quotePin(page3);
  if (Math.abs(located.lat + 34.91) > 0.02 || Math.abs(located.lng - 138.62) > 0.02) fail('use my location coords ' + located.lat + ',' + located.lng);
  await sleep(1200);
  if (both.reverse.length !== locateBefore + 1) fail('use my location reverse count ' + both.reverse.length);
  console.log('search and locate ok');

  await page.close();
  await page2.close();
  await page3.close();
  console.log('MAP PIN PASSED');
} finally {
  await browser.close();
  if (server) server.kill();
}
