/* headless-capture.mjs — render a public web page in a headless browser and hand back its text (3.9.3).
 *
 * Many vendor documentation sites are JavaScript applications: a plain fetch returns an empty shell
 * (references/10a-page-reader.md). Until now the only way past that was a model driving a browser tool
 * and carrying every page's text through its own context to a file — about 12k tokens a page, a typo
 * risk on every copy, and a browser tab that freezes under long scripts. This module does the same
 * rendering without a model: it starts the Chrome or Edge already on the machine, in headless mode,
 * drives it over the DevTools protocol and returns the text the page shows once it has settled. The
 * caller writes it straight to disk (snapshotStore.put), so page text never passes through a model.
 *
 * No dependency. It needs a Chromium browser (Chrome, Edge, Chromium, Brave) and Node 22+, whose global
 * WebSocket it uses. It reads public pages only: no profile, no cookies, no sign-in — each run starts
 * from an empty throwaway profile.
 *
 *   findBrowser(opts)           a Chromium executable path, or null
 *   openBrowser(opts)           → { capture(url, opts), close() } — one browser, one tab, pages in turn
 *   settled(samples, …)         has the page stopped growing? (pure; the part tests hold to account)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = {
  win32: () => {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe',
                 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    return roots.flatMap(r => rel.map(p => join(r, p)));
  },
  darwin: () => ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                 '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  linux: () => ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
                '/snap/bin/chromium', '/usr/bin/brave-browser'],
};

/** The browser to use: --browser / CONNECTOR_QA_BROWSER first, then the usual install paths. Null when there is none. */
export function findBrowser({ browser, env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const explicit = browser || env.CONNECTOR_QA_BROWSER;
  if (explicit) return exists(explicit) ? explicit : null;
  return (CANDIDATES[platform]?.() || []).find(p => exists(p)) || null;
}

/** Why a render cannot run here, as one line for the user; null when it can. */
export function renderBlocker({ browser, env, platform, exists, hasWebSocket = typeof globalThis.WebSocket === 'function' } = {}) {
  if (!hasWebSocket) return `rendering needs Node 22 or newer (this is ${process.version}); it uses Node's built-in WebSocket`;
  if (!findBrowser({ browser, env, platform, exists })) return 'no Chrome, Edge, Chromium or Brave found — install one, or point --browser / CONNECTOR_QA_BROWSER at its executable';
  return null;
}

/**
 * Has a page finished drawing? `samples` are the text lengths read at intervals `stepMs` apart, newest last.
 * Settled when there is some text and it did not change for `settleMs`.
 */
export function settled(samples, stepMs, settleMs) {
  const need = Math.max(2, Math.ceil(settleMs / Math.max(1, stepMs)) + 1);
  if (samples.length < need) return false;
  const tail = samples.slice(-need);
  return tail[0] > 0 && tail.every(n => n === tail[0]);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Start a headless browser and connect to it. Resolves to { capture, close }. Throws a readable Error. */
export async function openBrowser({ browser, userAgent, startTimeoutMs = 20000 } = {}) {
  const why = renderBlocker({ browser });
  if (why) throw new Error(why);
  const exe = findBrowser({ browser });
  const profile = mkdtempSync(join(tmpdir(), 'cqa-render-'));
  const child = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let exited = false; child.on('exit', () => { exited = true; });
  const cleanup = async () => {
    try { if (!exited) child.kill(); } catch { /* already gone */ }
    for (let i = 0; i < 5; i++) { try { rmSync(profile, { recursive: true, force: true }); return; } catch { await sleep(300); } }
  };
  try {
    /* Chromium writes the debugging port and the browser's WebSocket path here once it is listening */
    const portFile = join(profile, 'DevToolsActivePort');
    const t0 = Date.now(); let port = null, path = null;
    while (Date.now() - t0 < startTimeoutMs) {
      if (exited) throw new Error('the browser exited before it was ready');
      if (existsSync(portFile)) { const [p, w] = readFileSync(portFile, 'utf8').split(/\r?\n/); if (p && w) { port = p; path = w; break; } }
      await sleep(150);
    }
    if (!port) throw new Error(`the browser did not open a debugging port within ${startTimeoutMs / 1000}s`);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to the browser')); });
    let nextId = 1; const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result || {}); }
    };
    ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('the browser closed the connection')); pending.clear(); };
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = nextId++; pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => send(m, p, sessionId);
    await call('Page.enable');
    if (userAgent) await call('Emulation.setUserAgentOverride', { userAgent });
    const evalValue = async expr => (await call('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

    return {
      browser: exe,
      /**
       * Load `url`, wait until its text stops changing, return { text, title, url, timedOut }.
       * `stepMs` is the polling interval, `settleMs` how long the text must hold still, `timeoutMs` the ceiling.
       */
      async capture(url, { stepMs = 300, settleMs = 1500, timeoutMs = 45000 } = {}) {
        const nav = await call('Page.navigate', { url });
        if (nav.errorText) return { text: '', title: '', url, timedOut: false, error: nav.errorText };
        const t = Date.now(); const samples = []; let timedOut = false;
        for (;;) {
          await sleep(stepMs);
          samples.push(Number(await evalValue('document.body ? document.body.innerText.length : 0')) || 0);
          if (settled(samples, stepMs, settleMs) && (await evalValue('document.readyState')) === 'complete') break;
          if (Date.now() - t > timeoutMs) { timedOut = true; break; }
        }
        const text = String((await evalValue('document.body ? document.body.innerText : ""')) ?? '');
        const title = String((await evalValue('document.title')) ?? '');
        return { text, title, url: String((await evalValue('location.href')) || url), timedOut };
      },
      async close() {
        try { await send('Browser.close'); } catch { /* it may close the socket first */ }
        try { ws.close(); } catch { /* already closed */ }
        await cleanup();
      },
    };
  } catch (e) { await cleanup(); throw e; }
}
