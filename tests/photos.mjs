/**
 * Quote photos: IndexedDB blobs, metadata on the quote, preview, cleanup, migration.
 * Run: node tests/photos.mjs
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

async function boot(browser, w, h) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-go="new"]');
  return { page, errors };
}

async function addImage(page, w, h, name, which) {
  await page.evaluate(async (w, h, name, which) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = name === 'wide' ? '#b42318' : '#1e73be';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = '48px sans-serif';
    g.fillText(name, 24, 80);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const file = new File([blob], name + '.png', { type: 'image/png' });
    const input = document.querySelector(which);
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, w, h, name, which);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
});
const server = await ensureServer();

try {
  const { page, errors } = await boot(browser, 1376, 1032);
  await page.click('main [data-go="new"]');
  await page.waitForSelector('#sitesearch');
  await page.click('[data-step="7"]');
  await page.waitForSelector('[data-phdrop]');
  const targets = await page.evaluate(() => {
    const take = document.querySelector('[data-phfile]:not([multiple])');
    const pick = document.querySelector('[data-phfile][multiple]');
    const box = (el) => el.getBoundingClientRect();
    return {
      take: box(take.closest('label')).height,
      pick: box(pick.closest('label')).height,
      capture: take.hasAttribute('capture'),
      multiple: pick.multiple,
      accept: take.accept
    };
  });
  if (targets.take < 44 || targets.pick < 44) fail('photo buttons under 44px');
  if (!targets.capture || !targets.multiple || targets.accept !== 'image/*') fail('camera or library input is wrong ' + JSON.stringify(targets));

  await addImage(page, 2400, 1800, 'wide', '[data-phfile][multiple]');
  await page.waitForSelector('[data-phcard]');
  await page.waitForFunction(() => document.body.innerText.includes('Photo added') || document.querySelectorAll('[data-phcard]').length === 1);
  const scaled = await page.evaluate(async () => {
    const q = S.quotes.find((x) => x.id === R.id);
    const p = q.photos[0];
    const rec = await PH.get(q.id, p.id);
    const bmp = await createImageBitmap(rec.full);
    const thumb = await createImageBitmap(rec.thumb);
    const raw = localStorage.getItem('sacr-ipad-v1');
    return {
      w: bmp.width, h: bmp.height, tw: thumb.width, th: thumb.height,
      inDb: p.inDb, hasData: raw.includes('data:image'),
      tag: p.tag, unit: p.unitId, caption: p.caption
    };
  });
  if (scaled.w !== 1600 || scaled.h !== 1200) fail('full image not downscaled to 1600 long edge ' + JSON.stringify(scaled));
  if (Math.max(scaled.tw, scaled.th) > 320) fail('thumbnail larger than 320 ' + JSON.stringify(scaled));
  if (!scaled.inDb || scaled.hasData) fail('photo blob leaked into localStorage ' + JSON.stringify(scaled));
  if (scaled.tag !== 'other' || scaled.unit !== '') fail('new photo defaults ' + JSON.stringify(scaled));

  await page.type('[data-phcap]', 'Side path gate');
  await page.select('[data-phtag]', 'access');
  const unitId = await page.evaluate(() => {
    const q = S.quotes.find((x) => x.id === R.id);
    const sel = document.querySelector('[data-phunit]');
    sel.value = q.units[0].id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return q.units[0].id;
  });
  await addImage(page, 800, 600, 'second', '[data-phfile][multiple]');
  await page.waitForFunction(() => document.querySelectorAll('[data-phcard]').length === 2);

  const beforeOrder = await page.evaluate(() => S.quotes.find((x) => x.id === R.id).photos.map((p) => p.caption));
  await page.click('[data-phdown]');
  await page.waitForFunction(() => document.querySelectorAll('[data-phcard]').length === 2);
  const afterOrder = await page.evaluate(() => S.quotes.find((x) => x.id === R.id).photos.map((p) => p.caption));
  if (beforeOrder[0] !== 'Side path gate' || afterOrder[0] === beforeOrder[0]) fail('reorder did not move the first photo ' + JSON.stringify({ beforeOrder, afterOrder }));
  if (!afterOrder.includes('Side path gate')) fail('caption lost during reorder');

  const assigned = await page.evaluate((id) => {
    const p = S.quotes.find((x) => x.id === R.id).photos.find((x) => x.caption === 'Side path gate');
    return { tag: p.tag, unitId: p.unitId, expect: id };
  }, unitId);
  if (assigned.tag !== 'access' || assigned.unitId !== unitId) fail('tag or unit not saved ' + JSON.stringify(assigned));

  await page.click('[data-phopen]');
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-lbimg]');
    const box = document.querySelector('.lightbox');
    return box && !box.hidden && img && img.src && img.alt;
  });
  const lb = await page.evaluate(() => ({
    alt: document.querySelector('[data-lbimg]').alt,
    src: !!document.querySelector('[data-lbimg]').src
  }));
  if (!lb.src || !lb.alt) fail('lightbox did not show a photo');
  await page.click('[data-lbnext]');
  await page.waitForFunction(() => (document.querySelector('[data-lbcap]').textContent || '').includes('2 of 2') || (document.querySelector('[data-lbcap]').textContent || '').includes('1 of 2'));
  const swiped = await page.evaluate(() => {
    const before = LB.i;
    LB.swipe(-80);
    return { before, after: LB.i };
  });
  if (swiped.before === swiped.after) fail('swipe did not change photo');
  await page.evaluate(() => { LB.scale = 1; LB.pinch0 = { dist: 100, scale: 1 }; LB.scale = Math.min(5, Math.max(1, LB.pinch0.scale * (180 / LB.pinch0.dist))); LB.apply(); });
  const zoom = await page.evaluate(() => document.querySelector('[data-lbimg]').style.transform);
  if (!zoom.includes('scale(1.8)')) fail('pinch scale did not apply ' + zoom);
  await page.click('[data-lbmark]');
  await page.waitForSelector('.lightbox canvas');
  await page.evaluate(() => { LB.tool = 'pen'; LB.strokes.push({ t: 'pen', pts: [{ x: 10, y: 10 }, { x: 80, y: 40 }] }); LB.redraw(); });
  await page.click('[data-mksave]');
  await page.waitForFunction(() => {
    const q = S.quotes.find((x) => x.id === R.id);
    return q.photos.some((p) => p.annotated);
  });
  await page.click('[data-lbclose]');
  await page.waitForFunction(() => document.querySelector('.lightbox').hidden);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-open]');
  await page.evaluate(() => [...document.querySelectorAll('[data-open]')].find((el) => !el.innerText.includes('DEMO')).click());
  await page.waitForSelector('[data-phcard], [data-photos], [data-unitblock]');
  await page.click('[aria-label="Step 8: Photos"]');
  await page.waitForSelector('[data-phcard]');
  await page.waitForFunction(() => document.querySelector('img[data-phkind="thumb"]') && document.querySelector('img[data-phkind="thumb"]').src.startsWith('blob:'));
  const kept = await page.evaluate(async () => {
    const q = S.quotes.find((x) => !x.demo);
    const p = q.photos.find((x) => x.caption === 'Side path gate');
    const rec = await PH.get(q.id, p.id);
    return { caption: p.caption, tag: p.tag, unit: p.unitId, n: q.photos.length, blob: !!(rec && rec.full && rec.orig), annotated: q.photos.some((x) => x.annotated && x.origKept !== false) };
  });
  if (kept.caption !== 'Side path gate' || kept.tag !== 'access' || kept.n !== 2 || !kept.blob) fail('reload lost photo metadata or blob ' + JSON.stringify(kept));

  await page.click('[aria-label="Step 9: Review"]');
  await page.waitForSelector('[data-preview]');
  await page.click('[data-preview]');
  await page.waitForSelector('[data-phfig]');
  const preview = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('[data-phgroup]')].map((el) => el.textContent),
    caps: [...document.querySelectorAll('.phfig figcaption')].map((el) => el.textContent),
    imgs: [...document.querySelectorAll('.phfig img')].map((el) => el.dataset.phkind)
  }));
  if (!preview.caps.some((c) => c.includes('Side path gate'))) fail('preview missing caption ' + JSON.stringify(preview));
  if (!preview.groups.some((g) => g.includes('Coolroom')) || !preview.groups.some((g) => g.includes('Whole site'))) fail('preview grouping ' + JSON.stringify(preview));
  if (preview.imgs.some((k) => k !== 'full')) fail('preview is not using full photos');
  await page.screenshot({ path: `${ART}/after-photos-preview-ipad-1376x1032.png`, fullPage: true });

  await page.click('[data-edit]');
  await page.waitForSelector('[data-step="7"]');
  await page.click('[data-step="7"]');
  await page.waitForSelector('[data-phcard]');
  await page.screenshot({ path: `${ART}/after-photos-step-ipad-1376x1032.png` });

  const delId = await page.evaluate(() => S.quotes.find((x) => !x.demo).photos.find((p) => p.caption !== 'Side path gate').id);
  await page.click(`[data-phdel="${delId}"]`);
  await page.waitForSelector('[data-confirmph]');
  await page.click('[data-confirmph]');
  await page.waitForFunction(() => document.querySelectorAll('[data-phcard]').length === 1);
  const gone = await page.evaluate(async (id) => {
    const q = S.quotes.find((x) => !x.demo);
    return { listed: q.photos.some((p) => p.id === id), rec: await PH.get(q.id, id) };
  }, delId);
  if (gone.listed || gone.rec) fail('deleted photo still stored');

  await page.click('[data-step="2"]');
  await page.waitForSelector('[data-dupunit]');
  await page.click('[data-dupunit]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-unitcard]')].some((c) => c.innerText.includes('copy')));
  const copied = await page.evaluate(() => {
    const q = S.quotes.find((x) => !x.demo);
    const copy = q.units.find((u) => u.name.includes('copy'));
    const mine = q.photos.filter((p) => p.unitId === copy.id);
    return { n: mine.length, caption: mine[0] && mine[0].caption, same: mine[0] && mine[0].id === q.photos.find((p) => p.caption === 'Side path gate').id };
  });
  if (copied.n !== 1 || copied.caption !== 'Side path gate' || copied.same) fail('duplicate unit did not copy its photo ' + JSON.stringify(copied));

  const copyId = await page.evaluate(() => S.quotes.find((x) => !x.demo).units.find((u) => u.name.includes('copy')).id);
  await page.click(`[data-rmunit="${copyId}"]`);
  await page.waitForSelector('[data-confirmrm]');
  const confirm = await page.$eval('.modal .sheet', (el) => el.innerText);
  if (!confirm.includes('photo')) fail('remove unit does not mention photos: ' + confirm);
  await page.click('[data-confirmrm]');
  await page.waitForFunction(() => document.querySelectorAll('[data-unitcard]').length === 1);
  const cleaned = await page.evaluate(async (id) => {
    const q = S.quotes.find((x) => !x.demo);
    const left = q.photos.filter((p) => p.unitId === id);
    const recs = await Promise.all(q.photos.filter((p) => p.caption === 'Side path gate').map((p) => PH.get(q.id, p.id)));
    return { left: left.length, siteStill: q.photos.some((p) => p.caption === 'Side path gate' && p.unitId && p.unitId !== id), blobs: recs.filter(Boolean).length };
  }, copyId);
  if (cleaned.left !== 0) fail('unit delete left photos behind');
  if (!cleaned.siteStill || cleaned.blobs < 1) fail('original unit photo was removed with the copy ' + JSON.stringify(cleaned));

  await page.evaluate(() => {
    PH.put = () => Promise.reject(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }));
  });
  await page.click('[data-step="7"]');
  await page.waitForSelector('[data-phfile][multiple]');
  const beforeQuota = await page.evaluate(() => S.quotes.find((x) => !x.demo).photos.length);
  await addImage(page, 400, 300, 'extra', '[data-phfile][multiple]');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((el) => el.textContent.includes('out of space')));
  const afterQuota = await page.evaluate(() => S.quotes.find((x) => !x.demo).photos.length);
  if (afterQuota !== beforeQuota) fail('quota failure still added a photo');

  if (errors.length) fail('page errors ' + errors.join(' | '));
  await page.close();

  for (const [w, h] of VIEWS) {
    const b = await boot(browser, w, h);
    await b.page.click('main [data-go="new"]');
    await b.page.waitForSelector('[data-step="7"]');
    await b.page.click('[data-step="7"]');
    await b.page.waitForSelector('[data-phdrop]');
    await addImage(b.page, 640, 480, 'fit', '[data-phfile][multiple]');
    await b.page.waitForSelector('[data-phcard]');
    const fit = await b.page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      del: document.querySelector('[data-phdel]').getBoundingClientRect().height
    }));
    if (fit.overflow) fail(`${w}x${h} photos step overflows`);
    if (fit.del < 44) fail(`${w}x${h} delete control under 44px`);
    console.log('photos fit', w);
    await b.page.close();
  }

  const mig = await browser.newPage();
  await mig.setViewport({ width: 1376, height: 1032, deviceScaleFactor: 1 });
  const migErrors = [];
  mig.on('pageerror', (err) => migErrors.push(String(err)));
  await mig.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
  const dataUrl = await mig.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 800;
    const g = c.getContext('2d');
    g.fillStyle = '#11823b';
    g.fillRect(0, 0, 1200, 800);
    return c.toDataURL('image/jpeg', 0.8);
  });
  await mig.evaluate((dataUrl) => {
    const raw = JSON.parse(localStorage.getItem('sacr-ipad-v1'));
    const q = [...raw.quotes].sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
    q.photos = [{ id: 'oldphoto', sec: 6, data: dataUrl }];
    localStorage.setItem('sacr-ipad-v1', JSON.stringify(raw));
  }, dataUrl);
  await mig.reload({ waitUntil: 'domcontentloaded' });
  await mig.waitForFunction(() => {
    const raw = JSON.parse(localStorage.getItem('sacr-ipad-v1'));
    const q = raw.quotes.find((x) => (x.photos || []).some((p) => p.id === 'oldphoto'));
    const p = q && q.photos.find((x) => x.id === 'oldphoto');
    return p && p.inDb && !p.data && p.tag === 'access';
  });
  await mig.evaluate(() => document.querySelector('[data-open]').click());
  await mig.click('[aria-label="Step 8: Photos"]');
  await mig.waitForSelector('[data-phcard]');
  await mig.waitForFunction(() => {
    const img = document.querySelector('img[data-phid="oldphoto"]');
    return img && img.src.startsWith('blob:');
  });
  const migrated = await mig.evaluate(async () => {
    const q = S.quotes.find((x) => (x.photos || []).some((p) => p.id === 'oldphoto'));
    const p = q.photos.find((x) => x.id === 'oldphoto');
    const rec = await PH.get(q.id, p.id);
    const bmp = await createImageBitmap(rec.full);
    return { tag: p.tag, unit: p.unitId, caption: p.caption, w: bmp.width, stored: !JSON.parse(localStorage.getItem('sacr-ipad-v1')).quotes.some((x) => (x.photos || []).some((ph) => ph.data)) };
  });
  if (migrated.tag !== 'access' || migrated.unit !== '' || migrated.caption !== '') fail('old survey photo metadata ' + JSON.stringify(migrated));
  if (migrated.w > 1600 || !migrated.stored) fail('old survey photo was not moved into IndexedDB ' + JSON.stringify(migrated));
  if (migErrors.length) fail('migration errors ' + migErrors.join(' | '));
  console.log('photo migration', migrated);
  await mig.close();

  const demo = await boot(browser, 1376, 1032);
  await demo.page.waitForFunction(() => {
    const q = S.quotes.find((x) => x.demo);
    return q && q.examplePhotosSeeded && q.photos.filter((p) => p.example).length === 5;
  });
  const seeded = await demo.page.evaluate(async () => {
    const q = S.quotes.find((x) => x.demo);
    const unit = q.units[0].id;
    const raw = localStorage.getItem('sacr-ipad-v1');
    const rows = {};
    for (const p of q.photos) {
      const rec = await PH.get(q.id, p.id);
      const bmp = rec && rec.full ? await createImageBitmap(rec.full) : null;
      rows[p.id] = { tag: p.tag, caption: p.caption, unit: p.unitId, example: p.example, w: bmp && bmp.width, h: bmp && bmp.height };
    }
    return { unit, rows, leaked: raw.includes('data:image'), flagged: q.examplePhotosSeeded };
  });
  const expect = {
    'ex-site-access': ['access', 'Rear lane access, roller door and side gate', ''],
    'ex-plant': ['plant', 'Roof wall brackets for condensing unit', seeded.unit],
    'ex-existing': ['existing', 'Existing coolroom, evaporator and door to replace', seeded.unit],
    'ex-electrical': ['electrical', 'Main switchboard, back of house', ''],
    'ex-floor': ['floor', 'Slab with coolroom footprint marked out', '']
  };
  for (const [id, [tag, caption, unit]] of Object.entries(expect)) {
    const row = seeded.rows[id];
    if (!row || row.tag !== tag || row.caption !== caption || row.unit !== unit || !row.example) fail('demo seed ' + id + ' ' + JSON.stringify(row));
    if (!row.w || row.w > 1600 || row.h > 1600) fail('demo photo size ' + id + ' ' + JSON.stringify(row));
  }
  if (seeded.leaked) fail('example JPEGs were written into localStorage');
  await demo.page.evaluate(() => [...document.querySelectorAll('[data-open]')].find((el) => el.innerText.includes('DEMO')).click());
  await demo.page.waitForSelector('[aria-label="Step 8: Photos"]');
  await demo.page.click('[aria-label="Step 8: Photos"]');
  await demo.page.waitForSelector('[data-example="1"] .exbadge');
  const badges = await demo.page.evaluate(() => document.querySelectorAll('[data-phcard][data-example="1"] .exbadge').length);
  if (badges !== 5) fail('thumbnail badges ' + badges);
  await demo.page.click('[data-phopen="ex-plant"]');
  await demo.page.waitForFunction(() => (document.querySelector('[data-lbcap]') || {}).innerText && document.querySelector('[data-lbcap]').innerText.includes('Example photo'));
  await demo.page.click('[data-lbclose]');
  await demo.page.screenshot({ path: `${ART}/demo-photos-step-ipad-1376x1032.png` });
  await demo.page.click('[aria-label="Step 9: Review"]');
  await demo.page.waitForSelector('[data-preview]');
  await demo.page.click('[data-preview]');
  await demo.page.waitForSelector('.phfig[data-example="1"] .exbadge');
  const printed = await demo.page.evaluate(() => ({
    n: document.querySelectorAll('.phfig[data-example="1"]').length,
    site: [...document.querySelectorAll('[data-phgroup="site"]')].length,
    caps: document.body.innerText.includes('Rear lane access, roller door and side gate') && document.body.innerText.includes('Example photo')
  }));
  if (printed.n !== 5 || !printed.caps) fail('preview example photos ' + JSON.stringify(printed));
  await demo.page.screenshot({ path: `${ART}/demo-photos-preview-ipad-1376x1032.png`, fullPage: true });
  await demo.page.click('[data-edit]');
  await demo.page.click('[aria-label="Step 8: Photos"]');
  await demo.page.waitForSelector('[data-phdel="ex-site-access"]');
  await demo.page.click('[data-phdel="ex-site-access"]');
  await demo.page.waitForSelector('[data-confirmph="ex-site-access"]');
  await demo.page.click('[data-confirmph="ex-site-access"]');
  await demo.page.waitForFunction(() => !S.quotes.find((x) => x.demo).photos.some((p) => p.id === 'ex-site-access'));
  await demo.page.reload({ waitUntil: 'domcontentloaded' });
  await demo.page.waitForFunction(() => {
    const q = S.quotes.find((x) => x.demo);
    return q && q.examplePhotosSeeded && !q.photos.some((p) => p.id === 'ex-site-access') && q.photos.filter((p) => p.example).length === 4;
  });
  const fresh = await demo.page.evaluate(() => {
    const made = blankQuote();
    return { demo: S.quotes.find((x) => x.demo).photos.length, blank: made.photos.length, demoFlag: made.demo || false };
  });
  if (fresh.blank !== 0) fail('a new quote inherited example photos');
  if (demo.errors.length) fail('demo page errors ' + demo.errors.join(' | '));
  console.log('demo photos seeded once', fresh.demo);
  await demo.page.close();

  console.log('PHOTOS PASSED');
} finally {
  await browser.close();
  if (server) server.kill();
}
