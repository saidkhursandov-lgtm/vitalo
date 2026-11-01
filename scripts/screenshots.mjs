// Screenshots of the local Mini App and admin panel (dev servers on 5173 / 5174 must be running).
// Usage: node scripts/screenshots.mjs <out-dir> <plan.json>
// plan.json: [{ "app": "miniapp" | "admin", "width": 320, "lang": "ru" | "uz", "path": "/catalog", "file": "320-ru-catalog.jpg",
//              "url": "file:///…" (instead of app + path), "full": true, "wait": 1500, "scrollTo": ".css-selector", "scrollOffset": 300, "type": ["input.css", "text"],
//              "mock": { "match": "/api/orders/<id>", "patch": { … } } }]
// mock: for this shot only, the JSON answer of a request whose URL contains "match" gets the fields of "patch" on top
//       (to show a state without changing the database, e.g. a paid order); the shot's file name should say so
// mock.exact: the URL must end with "match" (not only contain it)
// mock.patch may be an array: the whole answer is replaced (lists such as /api/staff/promo-codes)
// js: a script run after click/type (e.g. open a block and press a button); "file" may be omitted for a setup step
// geo: { "lat": 41.36, "lon": 69.28 } — «Моё местоположение» answers with this point (permission granted for the shot)
// scrollOffset: after scrollTo, scroll back up this many px (the fixed top bar would cover the element otherwise)
// Uses headless Chrome over the DevTools protocol; nothing is installed. Signs in with the dev login (test users only).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [outDir, planFile] = process.argv.slice(2);
if (!outDir || !planFile) throw new Error('usage: node scripts/screenshots.mjs <out-dir> <plan.json>');
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
mkdirSync(outDir, { recursive: true });

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const BASE = { miniapp: 'http://localhost:5173', admin: 'http://localhost:5174' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'vitalo-shots')}`,
  '--hide-scrollbars', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
let mock = null;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') void onPaused(m.params);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;

async function onPaused(p) {
  try {
    if (mock && (mock.exact ? p.request.url.endsWith(mock.match) : p.request.url.includes(mock.match)) && p.responseStatusCode === 200) {
      const { body, base64Encoded } = await send('Fetch.getResponseBody', { requestId: p.requestId });
      const json = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
      const out = Buffer.from(JSON.stringify(Array.isArray(mock.patch) ? mock.patch : { ...json, ...mock.patch }), 'utf8').toString('base64');
      await send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: p.responseHeaders, body: out });
      return;
    }
  } catch { /* fall through: let the real answer pass */ }
  await send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined);
}

await send('Page.enable');
await send('Runtime.enable');

const signedIn = { miniapp: false, admin: false };
async function go(url) {
  await send('Page.navigate', { url });
  await sleep(1800);
}
async function signIn(app) {
  await go(BASE[app] + '/');
  // Dev login: first test user (miniapp «Тест», admin «Админ (тест)»).
  await evaluate(`(document.querySelector('.dev-login button, .login-card button')||{click(){}}).click()`);
  await sleep(2500);
  signedIn[app] = true;
}
async function setLang(lang) {
  await evaluate(`(() => { const b=[...document.querySelectorAll('.lang-switch button')].find(x=>x.textContent.trim().toLowerCase()==='${lang}'); if(b && !b.classList.contains('is-on')) b.click(); })()`);
  await sleep(1200);
}

for (const shot of plan) {
  const app = shot.app ?? 'miniapp';
  await send('Emulation.setDeviceMetricsOverride', { width: shot.width, height: shot.height ?? 800, deviceScaleFactor: 2, mobile: shot.width < 768 });
  if (!signedIn[app]) await signIn(app);
  mock = shot.mock ?? null;
  if (shot.geo) {
    await send('Browser.grantPermissions', { permissions: ['geolocation'], origin: BASE[app] });
    await send('Emulation.setGeolocationOverride', { latitude: shot.geo.lat, longitude: shot.geo.lon, accuracy: 20 });
  }
  if (mock) await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Response' }] });
  else await send('Fetch.disable');
  await go(shot.url ?? BASE[app] + shot.path);
  if (shot.lang) await setLang(shot.lang);
  if (shot.click) { await evaluate(`(() => { const b=[...document.querySelectorAll('${shot.click[0]}')].find(x=>x.textContent.includes(${JSON.stringify(shot.click[1])})); b && b.click(); })()`); await sleep(1000); }
  // type: fills a React input (native setter + input event), e.g. the search field of a sheet
  if (shot.type) { await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(shot.type[0])}); if(!el) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(shot.type[1])}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`); await sleep(800); }
  if (shot.js) { await evaluate(shot.js); await sleep(shot.jsWait ?? 1500); }
  if (!shot.file) continue;
  if (shot.scrollTo) await evaluate(`document.querySelector(${JSON.stringify(shot.scrollTo)})?.scrollIntoView({block:'start'})`);
  if (shot.scrollOffset) await evaluate(`window.scrollBy(0, -${Number(shot.scrollOffset)})`);
  await sleep(shot.wait ?? 800);
  const params = { format: 'jpeg', quality: 80 };
  if (shot.full) {
    // Grow the window to the whole page so the bottom menu stays at the bottom of the picture.
    const h = await evaluate('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)');
    await send('Emulation.setDeviceMetricsOverride', { width: shot.width, height: Math.min(h, 6000), deviceScaleFactor: 2, mobile: shot.width < 768 });
    await sleep(600);
  }
  const { data } = await send('Page.captureScreenshot', params);
  writeFileSync(join(outDir, shot.file), Buffer.from(data, 'base64'));
  console.log('saved', shot.file);
}

ws.close();
chrome.kill();
