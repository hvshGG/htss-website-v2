import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const browser = [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));
if (!browser) throw new Error('Set CHROME_PATH to an installed Chrome/Chromium browser.');
const artifacts = path.join(root, '.cache', 'browser');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), 'htss-browser-'));
const messages = [];
let rejectMail = false;
let releaseMail;
let holdMail = false;
const server = createServer({
  root: path.join(root, 'dist'),
  env: { CONTACT_TO: 'info@htss-co.kz', CONTACT_FROM: 'site@example.test', SMTP_HOST: 'smtp.example.test', SMTP_USER: 'test', SMTP_PASS: 'test' },
  rateLimit: { maximum: 100 },
  logger: { error() {} },
  mailer: { async sendMail(message) {
    messages.push(message);
    if (rejectMail) throw new Error('Simulated SMTP failure');
    if (holdMail) await new Promise((resolve) => { releaseMail = resolve; });
    return { accepted: ['info@htss-co.kz'] };
  } },
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
let count = 0;
const errors = [];
const resources = [];
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 20_000);
    chrome.stderr.on('data', (data) => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.on('error', reject);
  });
  const tabs = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map();
  const listeners = new Map();
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Network.requestWillBeSent') resources.push(message.params.request.url);
    if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
    (listeners.get(message.method) || []).splice(0).forEach((fn) => fn(message.params));
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 25_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const event = (name) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Event timed out: ${name}`)), 20_000);
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push((value) => { clearTimeout(timer); resolve(value); });
  });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, actual, expected = true) => { assert.deepEqual(actual, expected, name); count++; console.log(`PASS ${name}`); };
  const viewport = async (width, height) => { await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 }); await pause(80); };
  const navigate = async (url) => { const loaded = event('Page.loadEventFired'); await cdp('Page.navigate', { url }); await loaded; await evaluate('document.fonts.ready.then(()=>true)'); };
  const screenshot = async (name) => { const result = await cdp('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(artifacts, name), Buffer.from(result.data, 'base64')); };
  const key = async (key, options = {}) => { const windowsVirtualKeyCode = { Escape: 27, Tab: 9 }[key]; await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, ...options }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, ...options }); };
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Log.enable');
  await viewport(320, 568); await navigate(base);
  check('configured recipient', await evaluate('window.HTSS_CONFIG.contactEmail'), 'info@htss-co.kz');
  check('no remote page dependencies', resources.filter((url) => /^https?:/.test(url) && !url.startsWith(base)), []);
  const layouts = [];
  for (const [width, height] of [[320,568],[360,640],[390,844],[568,320],[768,1024]]) {
    await viewport(width, height);
    for (const lang of ['ru', 'kk', 'en']) {
      await evaluate(`window.HTSS_APP.setLanguage('${lang}')`);
      const layout = await evaluate(`(()=>({width:innerWidth,height:innerHeight,language:document.documentElement.lang,overflow:document.documentElement.scrollWidth>innerWidth,clipped:[...document.querySelectorAll('.hero-title span,.section-title,.principle h3,.direction-name,.capability-value,.service-card h3')].filter(x=>x.scrollWidth>x.clientWidth+2).map(x=>x.textContent),missing:[...document.querySelectorAll('[data-i18n],[data-i18n-content],[data-i18n-alt],[data-i18n-aria-label]')].flatMap(x=>[...x.attributes].filter(a=>a.name.startsWith('data-i18n')).filter(a=>!window.HTSS_TRANSLATIONS[document.documentElement.lang][a.value]).map(a=>a.value))}))()`);
      check(`${width}x${height} ${lang} layout`, !layout.overflow && !layout.clipped.length && !layout.missing.length);
      layouts.push(layout);
    }
  }
  check('mobile does not fetch video', resources.some((url) => url.endsWith('/hero.mp4')), false);
  await viewport(390, 844); await evaluate("HTSS_APP.setLanguage('ru');window.scrollTo({top:0,behavior:'instant'})"); await screenshot('mobile-390.png');
  await evaluate("document.querySelector('#mobile-menu-btn').click()");
  check('menu visible and background inert', await evaluate("!document.querySelector('#mobile-menu').hidden && document.querySelector('main').inert && getComputedStyle(document.body).overflow==='hidden'"));
  await screenshot('mobile-menu.png');
  await evaluate("document.querySelector('#mobile-menu [data-open-contact]').click()");
  check('mobile CTA keeps dialog scroll lock', await evaluate("document.querySelector('#contact-dialog').open && document.querySelector('#mobile-menu').hidden && getComputedStyle(document.body).overflow==='hidden' && document.activeElement.name==='name'"));
  await screenshot('mobile-dialog.png');
  await key('Escape'); await pause(80);
  check('Escape closes dialog and restores focus', await evaluate("({open:document.querySelector('#contact-dialog').open,focused:document.activeElement.id,locked:getComputedStyle(document.body).overflow==='hidden'})"), {open:false,focused:'mobile-menu-btn',locked:false});
  await evaluate("document.querySelector('[data-sector=eng]').click()");
  check('sector follows chosen card', await evaluate("document.querySelector('#contact-form').elements.sector.value"), 'eng');
  check('native dialog traps keyboard', await evaluate("document.querySelector('#contact-dialog').contains(document.activeElement)"));
  for (let i=0;i<12;i++) await key('Tab');
  check('Tab stays inside dialog', await evaluate("document.querySelector('#contact-dialog').contains(document.activeElement)"));
  await evaluate("HTSS_APP.closeContact()");
  await viewport(320,568); await evaluate("HTSS_APP.openContact(document.querySelector('[data-open-contact]'))");
  check('small dialog scrolls inside viewport', await evaluate("(()=>{const d=document.querySelector('#contact-dialog');const r=d.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.scrollHeight>d.clientHeight;})()"));
  await evaluate("(()=>{const f=document.querySelector('#contact-form');f.elements.name.value='Тест';f.elements.phone.value='abc';f.elements.sector.value='eng';f.elements.consent.checked=true;f.requestSubmit()})()");
  check('invalid phone does not submit', messages.length, 0);
  check('invalid phone has accessible error state', await evaluate("document.querySelector('#contact-phone').getAttribute('aria-invalid')"), 'true');
  await evaluate("(()=>{const f=document.querySelector('#contact-form');f.elements.phone.value='+7 701 123 45 67';f.elements.message.value='Browser test';f.requestSubmit()})()");
  await pause(250);
  check('confirmed delivery shows success', await evaluate("document.querySelector('#contact-status').dataset.state"), 'success');
  check('one valid request delivered to mock', messages.length, 1);
  rejectMail = true;
  await evaluate("(()=>{const f=document.querySelector('#contact-form');f.elements.name.value='Ошибка';f.elements.phone.value='+7 701 123 45 67';f.elements.sector.value='other';f.elements.consent.checked=true;f.elements.message.value='Do not lose this';f.requestSubmit()})()"); await pause(250);
  check('failure preserves details', await evaluate("document.querySelector('#contact-status').dataset.state==='error' && document.querySelector('#contact-form').elements.message.value==='Do not lose this'"));
  rejectMail = false; holdMail = true;
  await evaluate("document.querySelector('#contact-form').requestSubmit();document.querySelector('#contact-form').requestSubmit()"); await pause(100);
  check('duplicate click sends once', messages.length, 3);
  check('sending disables button', await evaluate("document.querySelector('#contact-submit').disabled"));
  releaseMail(); holdMail = false; await pause(150); await evaluate("HTSS_APP.closeContact()");
  for (const [width,height] of [[1024,768],[1200,900],[1440,900],[1920,1080]]) {
    await viewport(width,height);
    for (const lang of ['ru','kk','en']) {
      await evaluate(`HTSS_APP.setLanguage('${lang}')`);
      check(`desktop ${width} ${lang}`, await evaluate("document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.desktop-nav,.header-actions')].filter(x=>getComputedStyle(x).display!=='none').every(x=>x.getBoundingClientRect().right<=innerWidth)"));
    }
  }
  await viewport(1440,900); await evaluate("HTSS_APP.setLanguage('ru');window.scrollTo({top:0,behavior:'instant'})"); await pause(150); await screenshot('desktop-1440.png');
  await evaluate("document.querySelector('#about').scrollIntoView({behavior:'instant'})"); await screenshot('desktop-about.png');
  await evaluate("document.querySelector('#directions').scrollIntoView({behavior:'instant'})"); await screenshot('desktop-directions.png');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check('reduced motion stops video', await evaluate("document.querySelector('video').paused && getComputedStyle(document.documentElement).scrollBehavior==='auto'"));
  await navigate(`${base}/privacy.html`);
  for (const lang of ['ru','kk','en']) { await evaluate(`HTSS_APP.setLanguage('${lang}')`); check(`privacy ${lang}`, await evaluate("document.documentElement.scrollWidth<=innerWidth && document.title===HTSS_TRANSLATIONS[document.documentElement.lang].privacy_title")); }
  await cdp('Emulation.setScriptExecutionDisabled', { value: true }); await navigate(base);
  check('content readable without JavaScript', await evaluate("[...document.querySelectorAll('main section,h1,h2')].every(x=>getComputedStyle(x).visibility==='visible' && getComputedStyle(x).opacity!=='0')"));
  await cdp('Emulation.setScriptExecutionDisabled', { value: false });
  const badLanguage = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('htss_lang','__proto__')" });
  await navigate(base);
  check('invalid saved language falls back safely', await evaluate('document.documentElement.lang'), 'ru');
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: badLanguage.identifier });
  const noStorage = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window,'localStorage',{get(){throw new Error('Storage blocked for test')}})" });
  await navigate(base);
  check('blocked storage does not break page', await evaluate("Boolean(window.HTSS_APP) && document.documentElement.lang==='ru'"));
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: noStorage.identifier });
  for (const delivery of ['email', 'unconfigured']) {
    const fallback = createServer({ root: path.join(root, 'dist'), env: delivery === 'email' ? {CONTACT_TO:'info@htss-co.kz'} : {} });
    await new Promise((resolve) => fallback.listen(0,'127.0.0.1',resolve));
    try {
      await navigate(`http://127.0.0.1:${fallback.address().port}`);
      check(`${delivery} config is honest`, await evaluate('HTSS_CONFIG.delivery'), delivery);
      check(`${delivery} button state`, await evaluate("document.querySelector('#contact-submit').disabled"), delivery === 'unconfigured');
      if (delivery === 'email') check('email mode asks to open a draft', await evaluate("document.querySelector('#contact-submit').textContent===HTSS_APP.t('modal_email_action') && document.querySelector('#contact-status').textContent===HTSS_APP.t('modal_email_hint')"));
      else check('unconfigured mode offers a phone call', await evaluate("document.querySelector('#contact-status').textContent===HTSS_APP.t('modal_unconfigured')"));
    } finally {
      await new Promise((resolve) => {fallback.close(resolve);fallback.closeAllConnections();});
    }
  }
  check('no runtime or CSP errors', errors, []);
  await writeFile(path.join(artifacts,'layouts.json'),JSON.stringify(layouts,null,2));
  console.log(`${count} browser checks passed. Screenshots: .cache/browser/. No real emails sent.`);
} finally {
  socket?.close();
  chrome.kill();
  releaseMail?.();
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await new Promise((resolve) => chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('htss-browser-')) {
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
