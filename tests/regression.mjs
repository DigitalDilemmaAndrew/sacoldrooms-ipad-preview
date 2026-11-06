/**
 * Address-row labels and multi-unit quote behaviour.
 * Run: npm test
 * Requires Google Chrome and a local static server (started here if needed).
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const CHROME = process.env.CHROME || '/usr/local/bin/google-chrome';
const PORT = 8765;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const ART = process.env.SHOTS || '/opt/cursor/artifacts';
fs.mkdirSync(ART, { recursive: true });

const fail = (msg) => { throw new Error(msg); };
const near = (a, b, eps = 0.05) => Math.abs(+a - +b) <= eps;

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
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  fail('local server did not start');
}

async function boot(browser, width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-go="new"]');
  return { page, errors };
}

async function click(page, sel) {
  await page.waitForSelector(sel);
  await page.$eval(sel, (el) => el.click());
}

async function activate(page, name) {
  await page.evaluate((name) => {
    const els = [...document.querySelectorAll('[data-unit]')];
    const el = els.find((node) => {
      const title = node.querySelector('b');
      return (title ? title.textContent.trim() : node.textContent.trim()) === name;
    });
    if (!el) throw new Error('no unit button for ' + name);
    el.click();
  }, name);
}

async function setInput(page, sel, value) {
  await page.waitForSelector(sel);
  await page.$eval(sel, (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(value));
}

function measureButtons() {
  const fit = (el) => {
    const r = el.getBoundingClientRect();
    return {
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      w: r.width,
      h: r.height,
      scroll: el.scrollWidth,
      client: el.clientWidth,
      top: r.top,
      fs: parseFloat(getComputedStyle(el).fontSize)
    };
  };
  const search = document.getElementById('sitesearch');
  const pin = document.getElementById('sitepin');
  const input = document.getElementById('siteq');
  return {
    search: fit(search),
    pin: fit(pin),
    input: { ...fit(input), fs: parseFloat(getComputedStyle(input).fontSize) },
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  };
}

function assertLabels(m, where, { beside }) {
  for (const [name, el, expect] of [['Search', m.search, 'Search'], ['Use my location', m.pin, 'Use my location']]) {
    if (!el.text.includes(expect)) fail(`${where}: ${name} text is "${el.text}"`);
    if (el.scroll > el.client + 1) fail(`${where}: ${name} clipped (scroll ${el.scroll} > client ${el.client})`);
    if (el.h < 44) fail(`${where}: ${name} target ${el.h}px is under 44`);
  }
  if (m.input.fs < 16) fail(`${where}: input font ${m.input.fs}px is under 16`);
  if (m.input.h < 44) fail(`${where}: input target ${m.input.h}px is under 44`);
  if (m.overflow) fail(`${where}: page overflows horizontally`);
  if (beside && Math.abs(m.search.top - m.input.top) > 24) {
    fail(`${where}: Search is not beside the address input`);
  }
}

async function newQuote(page) {
  await click(page, '[data-go="new"]');
  await page.waitForSelector('#sitesearch');
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
});
const server = await ensureServer();

try {
  // --- address buttons at the viewports Andrew cares about ---
  const views = [
    ['ipad-1376x1032', 1376, 1032, true],
    ['desktop-1440x900', 1440, 900, true],
    ['narrow-1100x900', 1100, 900, true],
    ['phone-390x844', 390, 844, false],
    ['narrow-480x800', 480, 800, false]
  ];
  for (const [name, w, h, beside] of views) {
    const { page, errors } = await boot(browser, w, h);
    await newQuote(page);
    const m = await page.evaluate(measureButtons);
    assertLabels(m, name, { beside });
    await page.screenshot({ path: `${ART}/after-address-${name}.png` });
    const row = await page.$('.addrrow');
    const box = await row.boundingBox();
    if (box) {
      await page.screenshot({
        path: `${ART}/after-address-crop-${name}.png`,
        clip: { x: 0, y: Math.max(0, box.y - 36), width: Math.min(w, box.width + box.x + 8), height: Math.min(h - box.y + 36, 280) }
      });
    }
    if (errors.length) fail(`${name} page errors: ${errors.join(' | ')}`);
    console.log('labels', name, JSON.stringify({ search: m.search.w, pin: m.pin.w, input: m.input.w, beside }));
    await page.close();
  }

  // --- one coolroom and one freezer ---
  const { page, errors } = await boot(browser, 1376, 1032);
  await newQuote(page);
  await click(page, '[data-step="2"]');
  await page.waitForSelector('input[data-u="L"]');
  await page.screenshot({ path: `${ART}/after-room-units-ipad-1376x1032.png` });
  if (await page.$('[data-set="room"]')) fail('quote-wide room toggle is still on the room step');
  await setInput(page, 'input[data-u="L"]', '4000');
  await setInput(page, 'input[data-u="W"]', '3000');
  await setInput(page, 'input[data-u="H"]', '2400');
  await setInput(page, 'textarea[data-u="notes"]', 'cr-note');

  await click(page, '[data-addunit]');
  await click(page, '[data-makeunit="freezer"]');
  await page.waitForSelector('input[data-u="name"]');
  const fzName = await page.$eval('input[data-u="name"]', (el) => el.value);
  if (fzName !== 'Freezer 1') fail('new freezer default name is ' + fzName);
  const fzType = await page.$eval('[data-uroom="freezer"]', (el) => el.classList.contains('on'));
  if (!fzType) fail('new unit did not select freezer');
  await setInput(page, 'input[data-u="L"]', '2000');
  await setInput(page, 'input[data-u="W"]', '2000');
  await setInput(page, 'input[data-u="H"]', '2200');
  await setInput(page, 'textarea[data-u="notes"]', 'fz-note');

  await click(page, '[data-step="6"]');
  await page.waitForSelector('[data-scope="unit"][data-k="hours"]');
  await setInput(page, '[data-scope="unit"][data-k="hours"]', '3');
  await setInput(page, '[data-scope="unit"][data-k="rate"]', '70');
  await activate(page, 'Coolroom 1');
  await page.waitForFunction(() => document.body.innerText.includes('Labour · Coolroom 1'));
  await setInput(page, '[data-scope="unit"][data-k="hours"]', '8');
  await setInput(page, '[data-scope="unit"][data-k="rate"]', '90');

  await click(page, '[data-step="5"]');
  await page.waitForSelector('[data-addfree="extras"][data-desc="Freight"]');
  await click(page, '[data-addfree="extras"][data-desc="Freight"]');
  await page.waitForSelector('[data-free="extras"][data-k="desc"]');
  await setInput(page, '[data-free="extras"][data-k="desc"]', 'TEST FREIGHT ONCE');
  await setInput(page, '[data-free="extras"][data-k="amt"]', '175');

  await click(page, '[data-step="8"]');
  await page.waitForSelector('[data-quotetotals]');
  const beforeDoors = await page.evaluate(() => {
    const q = document.querySelector('[data-quotetotals]');
    const blocks = [...document.querySelectorAll('[data-unitblock]')].map((el) => ({
      id: el.dataset.unitblock,
      sub: +el.dataset.unitsub,
      text: el.innerText
    }));
    return {
      blocks,
      shared: +document.querySelector('[data-sharedblock]').dataset.sharedsub,
      sub: +q.dataset.sub,
      mk: +q.dataset.mk,
      ex: +q.dataset.ex,
      gst: +q.dataset.gst,
      inc: +q.dataset.inc,
      freight: document.body.innerText.split('TEST FREIGHT ONCE').length - 1
    };
  });
  const cr = beforeDoors.blocks.find((b) => b.text.includes('cr-note'));
  const fz = beforeDoors.blocks.find((b) => b.text.includes('fz-note'));
  if (!cr || !fz) fail('review is missing one of the unit notes: ' + JSON.stringify(beforeDoors.blocks.map((b) => b.text.slice(0, 80))));
  // EPS 75mm at $64/m2, 75mm suspension kit $30. Labour entered on the line. Freight once.
  const crPanel = 45.6 * 64 + 3 * 30 + 8 * 90;
  const fzPanel = 21.6 * 64 + 1 * 30 + 3 * 70;
  if (!near(cr.sub, crPanel)) fail(`coolroom subtotal ${cr.sub} expected ${crPanel}`);
  if (!near(fz.sub, fzPanel)) fail(`freezer subtotal ${fz.sub} expected ${fzPanel}`);
  if (!near(beforeDoors.shared, 175)) fail('shared extras ' + beforeDoors.shared);
  if (beforeDoors.freight !== 1) fail('freight shown ' + beforeDoors.freight + ' times');
  if (!near(beforeDoors.sub, crPanel + fzPanel + 175)) fail('combined subtotal double-counts or drops a unit');
  if (!near(beforeDoors.mk, 0)) fail('markup should still be 0');
  if (!near(beforeDoors.ex, beforeDoors.sub)) fail('ex GST is not the subtotal');
  if (!near(beforeDoors.gst, beforeDoors.ex * 0.1)) fail('GST was not 10% once');
  if (!near(beforeDoors.inc, beforeDoors.ex + beforeDoors.gst)) fail('inc GST mismatch');

  await setInput(page, 'input[data-q="markup"]', '10');
  await page.waitForSelector('[data-quotetotals]');
  const marked = await page.$eval('[data-quotetotals]', (el) => ({
    sub: +el.dataset.sub, mk: +el.dataset.mk, ex: +el.dataset.ex, gst: +el.dataset.gst, inc: +el.dataset.inc
  }));
  if (!near(marked.mk, marked.sub * 0.1)) fail('markup not applied once: ' + JSON.stringify(marked));
  if (!near(marked.ex, marked.sub + marked.mk)) fail('markup changed the base twice');
  if (!near(marked.gst, marked.ex * 0.1, 0.02)) fail('GST not once after markup');
  if (!near(marked.inc, marked.ex + marked.gst, 0.02)) fail('inc GST after markup');
  await setInput(page, 'input[data-q="markup"]', '0');

  // doors differ per unit
  await click(page, '[data-step="4"]');
  await page.waitForSelector('[data-adddoor]');
  await activate(page, 'Coolroom 1');
  await page.waitForSelector('[data-adddoor]');
  await click(page, '[data-adddoor]');
  await page.waitForSelector('[data-door][data-k="type"][data-val="hinged"]');
  await activate(page, 'Freezer 1');
  await page.waitForSelector('[data-adddoor]');
  await click(page, '[data-adddoor]');
  await page.waitForSelector('[data-door][data-k="type"][data-val="sliding"]');
  await click(page, '[data-door][data-k="type"][data-val="sliding"]');
  await page.waitForSelector('[data-door][data-k="type"][data-val="sliding"].on');

  await click(page, '[data-step="8"]');
  await page.waitForSelector('[data-unitblock]');
  const withDoors = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('[data-unitblock]')].map((el) => ({ sub: +el.dataset.unitsub, text: el.innerText }));
    const freight = document.body.innerText.split('TEST FREIGHT ONCE').length - 1;
    const q = document.querySelector('[data-quotetotals]');
    return { blocks, freight, sub: +q.dataset.sub, shared: +document.querySelector('[data-sharedblock]').dataset.sharedsub };
  });
  const cr2 = withDoors.blocks.find((b) => b.text.includes('cr-note'));
  const fz2 = withDoors.blocks.find((b) => b.text.includes('fz-note'));
  if (!(cr2.sub > cr.sub + 1)) fail('coolroom door did not add cost');
  if (!(fz2.sub > fz.sub + 1)) fail('freezer door did not add cost');
  if (near(cr2.sub - cr.sub, fz2.sub - fz.sub, 1)) fail('hinged and sliding doors changed the subtotals by the same amount');
  if (!cr2.text.includes('CSH hinged') || !fz2.text.includes('Sliding')) fail('door types leaked between units');
  if (withDoors.freight !== 1) fail('freight duplicated after doors');
  if (!near(withDoors.shared, 175)) fail('shared extras changed when doors were added');
  if (!near(withDoors.sub, cr2.sub + fz2.sub + 175)) fail('combined total duplicated a unit or the extra');
  await page.screenshot({ path: `${ART}/after-review-two-units-ipad-1376x1032.png`, fullPage: true });

  // back / switch keeps each unit
  await click(page, '[data-step="2"]');
  await activate(page, 'Freezer 1');
  await page.waitForFunction(() => document.querySelector('input[data-u="L"]') && document.querySelector('input[data-u="L"]').value === '2000');
  const fzDims = await page.evaluate(() => ({
    L: document.querySelector('input[data-u="L"]').value,
    W: document.querySelector('input[data-u="W"]').value,
    H: document.querySelector('input[data-u="H"]').value,
    notes: document.querySelector('textarea[data-u="notes"]').value
  }));
  if (fzDims.L !== '2000' || fzDims.W !== '2000' || fzDims.H !== '2200' || fzDims.notes !== 'fz-note') {
    fail('freezer dims changed before sketch: ' + JSON.stringify(fzDims));
  }
  await activate(page, 'Coolroom 1');
  await page.waitForFunction(() => document.querySelector('input[data-u="H"]').value === '2400');

  // sketch push hits the active unit only
  await click(page, '[data-step="1"]');
  await page.waitForSelector('.skarea canvas');
  const box = await (await page.$('.skarea canvas')).boundingBox();
  if (!box || box.width < 50) fail('sketch canvas has no size');
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 160, { steps: 12 });
  await page.mouse.up();
  await click(page, '[data-ska="pushq"]');
  await page.waitForFunction(() => document.body.innerText.includes('Coolroom 1:'));
  await click(page, '[data-step="2"]');
  await activate(page, 'Freezer 1');
  await page.waitForFunction(() => document.querySelector('textarea[data-u="notes"]'));
  const afterSketch = await page.evaluate(() => ({
    L: document.querySelector('input[data-u="L"]').value,
    W: document.querySelector('input[data-u="W"]').value,
    H: document.querySelector('input[data-u="H"]').value,
    notes: document.querySelector('textarea[data-u="notes"]').value,
    cool: null
  }));
  if (afterSketch.L !== '2000' || afterSketch.W !== '2000' || afterSketch.H !== '2200' || afterSketch.notes !== 'fz-note') {
    fail('sketch dims leaked into the freezer: ' + JSON.stringify(afterSketch));
  }
  await activate(page, 'Coolroom 1');
  await page.waitForFunction(() => document.querySelector('input[data-u="H"]').value === '2400');
  const crAfter = await page.evaluate(() => ({
    L: document.querySelector('input[data-u="L"]').value,
    W: document.querySelector('input[data-u="W"]').value,
    H: document.querySelector('input[data-u="H"]').value,
    notes: document.querySelector('textarea[data-u="notes"]').value
  }));
  if (crAfter.H !== '2400' || crAfter.notes !== 'cr-note') fail('coolroom height or note changed: ' + JSON.stringify(crAfter));
  if (crAfter.L === '4000' && crAfter.W === '3000') fail('sketch push did not update the active coolroom');

  // duplicate and remove
  await page.evaluate(() => [...document.querySelectorAll('[data-unitcard]')].find((c) => c.innerText.startsWith('Freezer 1')).querySelector('[data-dupunit]').click());
  await page.waitForFunction(() => [...document.querySelectorAll('[data-unitcard]')].some((c) => c.innerText.includes('Freezer 1 copy')));
  const copyDims = await page.evaluate(() => ({
    L: document.querySelector('input[data-u="L"]').value,
    W: document.querySelector('input[data-u="W"]').value,
    H: document.querySelector('input[data-u="H"]').value,
    cards: document.querySelectorAll('[data-unitcard]').length
  }));
  if (copyDims.cards !== 3 || copyDims.L !== '2000' || copyDims.H !== '2200') fail('duplicate did not copy the freezer: ' + JSON.stringify(copyDims));
  await click(page, '[data-step="8"]');
  await page.waitForSelector('[data-sharedblock]');
  const freightAfterDup = await page.evaluate(() => document.body.innerText.split('TEST FREIGHT ONCE').length - 1);
  if (freightAfterDup !== 1) fail('duplicating a unit duplicated project freight');
  await click(page, '[data-step="2"]');
  await page.evaluate(() => [...document.querySelectorAll('[data-unitcard]')].find((c) => c.innerText.includes('Freezer 1 copy')).querySelector('[data-rmunit]').click());
  await page.waitForSelector('[data-confirmrm]');
  const confirmText = await page.$eval('.modal .sheet', (el) => el.innerText);
  if (!confirmText.includes('Freezer 1 copy') || !confirmText.includes('project extras stay')) fail('remove confirmation is unclear: ' + confirmText);
  await click(page, '[data-confirmrm]');
  await page.waitForFunction(() => document.querySelectorAll('[data-unitcard]').length === 2);

  // reload preserves both units
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-open]');
  await page.evaluate(() => [...document.querySelectorAll('[data-open]')].find((el) => !el.innerText.includes('DEMO')).click());
  await page.waitForSelector('[data-unitblock]');
  const reloaded = await page.evaluate(() => [...document.querySelectorAll('[data-unitblock]')].map((el) => el.innerText.slice(0, 180)));
  if (reloaded.length !== 2) fail('reload unit count ' + reloaded.length);
  const joined = reloaded.join('\n');
  if (!joined.includes('4000') && !joined.includes('cr-note')) fail('coolroom missing after reload');
  if (!joined.includes('2200') || !joined.includes('fz-note')) fail('freezer missing after reload: ' + joined);
  if ((joined.match(/TEST FREIGHT ONCE/g) || []).length !== 0) {
    // freight is in the shared block, not the unit blocks
  }
  const freightReload = await page.evaluate(() => document.body.innerText.split('TEST FREIGHT ONCE').length - 1);
  if (freightReload !== 1) fail('freight count after reload ' + freightReload);
  if (errors.length) fail('wizard page errors: ' + errors.join(' | '));
  await page.close();

  // --- old single-unit quote migrates without doubling ---
  const mig = await browser.newPage();
  await mig.setViewport({ width: 1376, height: 1032, deviceScaleFactor: 1 });
  const migErrors = [];
  mig.on('pageerror', (err) => migErrors.push(String(err)));
  await mig.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await mig.evaluate((payload) => localStorage.setItem('sacr-ipad-v1', JSON.stringify(payload)), {
    items: [
      { id: 'r87', cat: 'EPS panel', name: 'EPS panel 75mm surfmist', unit: 'm2', cost: 60.43, sell: 64, note: '' },
      { id: 'r82', cat: 'Fixings & consumables', name: '75mm ceiling suspension kit', unit: 'each', cost: 17.86, sell: 30, note: '' }
    ],
    labour: [
      { id: 'lt-install', name: 'Install', rate: null, hours: null },
      { id: 'lt-service', name: 'Servicing', rate: null, hours: null }
    ],
    gst: 10,
    mapsKey: '',
    seq: 1002,
    quotes: [{
      id: 'old1', no: 'Q1001', status: 'draft', created: '2026-11-01T00:00:00.000Z',
      customer: 'Mig Co', phone: '', email: '', site: '1 St', street: '1 St', suburb: 'Adelaide', state: 'SA', postcode: '5000',
      lat: null, lng: null, notes: 'keep-me',
      room: 'chiller', L: 5000, W: 3000, H: 2400, panel: 'r87', panelWidth: 1200, floor: 'none', floorPanel: '',
      useSk: false, perim: null, skArea: null, doors: [],
      refrig: [{ id: 'r1', desc: 'Plant once', amt: 1000 }],
      extras: [{ id: 'e1', desc: 'MIG FREIGHT', amt: 200 }],
      labour: [{ id: 'l1', type: 'lt-install', hours: 5, rate: 50 }],
      markup: 0, ov: { panel: 10 }, sv: {}, photos: [],
      sk: { shapes: [], grid: 100, view: null }, skPng: ''
    }]
  });
  await mig.reload({ waitUntil: 'domcontentloaded' });
  await mig.waitForSelector('[data-open]');
  const stored = await mig.evaluate(() => {
    const q = JSON.parse(localStorage.getItem('sacr-ipad-v1')).quotes[0];
    return { units: q.units.length, name: q.units[0].name, L: q.units[0].L, room: q.room, extras: q.extras.length, labourOnUnit: q.units[0].labour.length, ov: q.units[0].ov.panel, customer: q.customer, notes: q.notes };
  });
  if (stored.units !== 1 || stored.name !== 'Coolroom 1' || stored.L !== 5000) fail('migration shape ' + JSON.stringify(stored));
  if (stored.room != null) fail('old room field still on the quote');
  if (stored.extras !== 1 || stored.labourOnUnit !== 1 || stored.ov !== 10) fail('migration moved shared data onto the wrong place ' + JSON.stringify(stored));
  if (stored.customer !== 'Mig Co' || stored.notes !== 'keep-me') fail('migration dropped the quote header');
  await mig.evaluate(() => document.querySelector('[data-open]').click());
  await mig.waitForSelector('[data-quotetotals]');
  const migTot = await mig.$eval('[data-quotetotals]', (el) => ({ sub: +el.dataset.sub, inc: +el.dataset.inc, gst: +el.dataset.gst }));
  // Walls+ceiling 53.4 m2 overridden to $10, suspension 4 x $30, plant $1000, labour $250, freight $200.
  const expectSub = 10 + 120 + 1000 + 250 + 200;
  if (!near(migTot.sub, expectSub)) fail(`migrated subtotal ${migTot.sub} expected ${expectSub}`);
  if (!near(migTot.gst, expectSub * 0.1)) fail('migrated GST');
  if (!near(migTot.inc, expectSub * 1.1)) fail('migrated inc GST');
  const migFreight = await mig.evaluate(() => document.body.innerText.split('MIG FREIGHT').length - 1);
  if (migFreight !== 1) fail('migrated freight count ' + migFreight);
  if (migErrors.length) fail('migration page errors ' + migErrors.join(' | '));
  console.log('migration ok', migTot);
  await mig.close();

  console.log('ALL PASSED');
} finally {
  await browser.close();
  if (server) server.kill();
}
