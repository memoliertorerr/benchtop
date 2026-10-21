/**
 * Screenshots of the app (BT40) — the README's docs/images — through a headless Chromium's
 * DevTools protocol, with no dependency: Node's own WebSocket and fetch.
 *
 *   npm run dev                                  # in another terminal (the app on :5173)
 *   npm run screenshots -- [--out docs/images] [--scenes scenes.json] [--only name,…]
 *                          [--url http://localhost:5173/] [--browser <path>]
 *
 * It finds Chrome, Chromium, Edge or Brave (or BENCHTOP_BROWSER / --browser), starts it headless
 * with a throwaway profile, and for each scene: stores the project and firmware where the app
 * restores them from (localStorage, IndexedDB), reloads, frames the circuit (the F shortcut,
 * then optional wheel steps), runs, adds probes by pin name, opens a bottom tab, waits and
 * captures 1440×900 at 2×. The browser and its profile are removed afterwards. Stop the dev
 * server when done: a tab left simulating makes the timing tests in `npm run verify` flake.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

export interface Scene {
  /** Output file name, without .png. */
  name: string;
  /** fixtures/projects/<project>.json */
  project: string;
  /** Repo-relative firmware file for the project's board. */
  firmware: string;
  /** The board part id (default: the project's first Uno or DevKit). */
  board?: string;
  /** Wall time to let it run before the capture, ms. */
  wait: number;
  /** Mouse wheel steps after framing: [deltaX, deltaY, zoom (⌘/Ctrl held)]. */
  wheel?: [number, number, boolean?][];
  /** Pins to probe on the board after Run (Logic analyzer), e.g. ["3", "9"]. */
  probes?: string[];
  /** A bottom panel tab to open before the capture, by its label. */
  tab?: string;
}

/** The README's images. */
export const README_SCENES: Scene[] = [
  { name: 'uno-neopixel', project: 'neopixel', firmware: 'fixtures/firmware/uno/neopixel.hex', wait: 2000 },
  { name: 'esp32-neopixel', project: 'esp32-neopixel', firmware: 'fixtures/firmware/esp32/neopixel.bin', wait: 1800 },
  { name: 'uno-oled', project: 'ssd1306-adafruit', firmware: 'fixtures/firmware/uno/ssd1306-adafruit.hex', wait: 2500 },
  { name: 'logic-analyzer', project: 'logic-demo', firmware: 'fixtures/firmware/uno/logic-demo.hex', wait: 2500, probes: ['3', '9', '7'], tab: 'Logic analyzer' },
];

const REPO = resolve(new URL('..', import.meta.url).pathname);
const BOARD_TYPES = ['arduino-uno', 'esp32-devkit-v1'];

/** A Chromium-family browser on this machine, or undefined. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.BENCHTOP_BROWSER) return env.BENCHTOP_BROWSER;
  const candidates: string[] = [];
  if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser']) candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
  } else if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]) {
      if (base === undefined) continue;
      candidates.push(join(base, 'Google/Chrome/Application/chrome.exe'), join(base, 'Microsoft/Edge/Application/msedge.exe'), join(base, 'Chromium/Application/chrome.exe'));
    }
  } else {
    for (const dir of (env.PATH ?? '').split(delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) candidates.push(join(dir, name));
    }
  }
  return candidates.find((path) => existsSync(path));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Starts the browser headless on a throwaway profile; resolves with its DevTools page socket. */
async function launch(browser: string): Promise<{ child: ChildProcess; profile: string; ws: WebSocket }> {
  const profile = mkdtempSync(join(tmpdir(), 'benchtop-shots-'));
  const child = spawn(
    browser,
    ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,900', 'about:blank'],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) throw new Error(`${browser} did not open its DevTools port`);
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page');
  if (page === undefined) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, reject) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return { child, profile, ws };
}

function devtools(ws: WebSocket) {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; error?: unknown; result?: unknown };
    const entry = msg.id === undefined ? undefined : pending.get(msg.id);
    if (entry === undefined || msg.id === undefined) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  });
  const send = <T = unknown>(method: string, params: object = {}): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const r = await send<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  const key = async (key: string, code: string, keyCode: number) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text: key.length === 1 ? key : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  };
  return { send, evaluate, key };
}

async function shoot(scene: Scene, app: string, outDir: string, cdp: ReturnType<typeof devtools>): Promise<void> {
  const { send, evaluate, key } = cdp;
  const doc = JSON.parse(readFileSync(join(REPO, 'fixtures/projects', `${scene.project}.json`), 'utf8')) as {
    parts: { id: string; type: string }[];
    firmware?: Record<string, unknown>;
  };
  const board = scene.board ?? doc.parts.find((p) => BOARD_TYPES.includes(p.type))?.id;
  if (board === undefined) throw new Error(`${scene.project}: no board`);
  const name = scene.firmware.split('/').pop() as string;
  const format = name.endsWith('.hex') ? 'hex' : name.endsWith('.elf') ? 'elf' : 'esp32-bin';
  // A project without a firmware ref doesn't pick up stored firmware: add the ref.
  doc.firmware = { ...(doc.firmware ?? {}), [board]: { kind: 'file', name, format } };
  const bytes = readFileSync(join(REPO, scene.firmware)).toString('base64');

  await send('Page.navigate', { url: app });
  await sleep(2000);
  await evaluate(`(async () => {
    localStorage.setItem('benchtop:project:v1', ${JSON.stringify(JSON.stringify(doc))});
    const bytes = Uint8Array.from(atob(${JSON.stringify(bytes)}), (c) => c.charCodeAt(0));
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('benchtop', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('firmware');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('firmware', 'readwrite');
        tx.objectStore('firmware').put({ name: ${JSON.stringify(name)}, format: ${JSON.stringify(format)}, bytes }, ${JSON.stringify(board)});
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  })()`);
  await send('Page.reload');
  await sleep(3000);
  await key('f', 'KeyF', 70); // fit the circuit in view
  await sleep(200);
  for (const [dx, dy, zoom] of scene.wheel ?? []) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 780, y: 360, deltaX: dx, deltaY: dy, modifiers: zoom === true ? 2 : 0 });
    await sleep(150);
  }
  await evaluate(`document.querySelector('button[title="Run"]')?.click()`);
  await sleep(500);
  if (scene.probes !== undefined && scene.probes.length > 0) {
    await evaluate(`document.querySelector('button[title^="Probe tool"]').click()`);
    await sleep(300);
    for (const pin of scene.probes) {
      // The pin's world position (mm) through the world layer's transform to the screen.
      const [x, y] = await evaluate<[number, number]>(`(async () => {
        const { editor } = await import('/src/editor/app-store.ts');
        const { pinPosition } = await import('/src/editor/pins.ts');
        const { PX_PER_MM } = await import('/src/editor/camera.ts');
        const at = pinPosition(editor.doc.value, { part: ${JSON.stringify(board)}, pin: ${JSON.stringify(pin)} });
        if (at === undefined) throw new Error('no pin ${pin}');
        const world = document.querySelector('.workbench .world');
        const m = new DOMMatrix(getComputedStyle(world).transform);
        const bench = world.parentElement.getBoundingClientRect();
        return [bench.left + m.e + m.a * at.x * PX_PER_MM, bench.top + m.f + m.d * at.y * PX_PER_MM];
      })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        await sleep(60);
      }
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1500, y: 800 });
    await key('Escape', 'Escape', 27);
  }
  if (scene.tab !== undefined) {
    await evaluate(`[...document.querySelectorAll('[role="tab"], .panel-tabs button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(scene.tab)}))?.click()`);
  }
  await sleep(scene.wait);
  const shot = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  const file = join(outDir, `${scene.name}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  ${file}`);
}

async function main(argv: string[]): Promise<number> {
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outDir = resolve(arg('--out') ?? join(REPO, 'docs/images'));
  const app = arg('--url') ?? 'http://localhost:5173/';
  const scenesFile = arg('--scenes');
  const only = arg('--only')?.split(',');
  let scenes = scenesFile === undefined ? README_SCENES : (JSON.parse(readFileSync(scenesFile, 'utf8')) as Scene[]);
  if (only !== undefined) scenes = scenes.filter((s) => only.includes(s.name));
  const browser = arg('--browser') ?? findBrowser();
  if (browser === undefined) {
    console.error('No Chromium-family browser found (Chrome, Chromium, Edge, Brave). Pass --browser <path> or set BENCHTOP_BROWSER.');
    return 2;
  }
  try {
    await fetch(app);
  } catch {
    console.error(`The app isn't reachable at ${app}: start it with \`npm run dev\` first.`);
    return 2;
  }
  console.log(`${browser} → ${outDir}`);
  const { child, profile, ws } = await launch(browser);
  try {
    const cdp = devtools(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    for (const scene of scenes) await shoot(scene, app, outDir, cdp);
  } finally {
    ws.close();
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once('exit', r)));
    rmSync(profile, { recursive: true, force: true });
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = await main(process.argv.slice(2));
}
