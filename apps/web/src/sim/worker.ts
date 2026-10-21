/**
 * The simulation worker: a thin adapter from the worker scope to SimSession. Ticks are
 * scheduled through a MessageChannel, because nested setTimeout calls clamp to 4 ms.
 *
 * The ESP32 ROM (BT34) is fetched once, from /esp32-rom/esp32_rev0_rom.elf — the dev server
 * serves it from .cache/esp32-rom (vite.config.ts); it is never part of the build. Messages wait
 * until that fetch has settled, so a project restored at startup sees the ROM. Missing or not
 * found, ESP32 boards report `esp32-rom-missing` instead; the worker never fails on it.
 *
 * Cross-origin isolated (BT40), the session publishes part visual state in a SharedArrayBuffer
 * frame ring the UI reads on requestAnimationFrame (frame-ring.ts); otherwise in frame messages.
 */

import type { FromSim, ToSim } from './protocol.ts';
import { SimSession } from './session.ts';

// The DOM lib types `self` as a Window; inside a dedicated worker only these members matter.
interface WorkerScope {
  postMessage(message: FromSim, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToSim>) => void) | null;
}

const scope = self as unknown as WorkerScope;

const channel = new MessageChannel();
let pending: (() => void) | null = null;
channel.port1.onmessage = () => {
  const fn = pending;
  pending = null;
  fn?.();
};

let esp32Rom: Uint8Array | undefined;

const session = new SimSession({
  post: (message, transfer) => scope.postMessage(message, transfer),
  now: () => performance.now(),
  schedule: (fn) => {
    pending = fn;
    channel.port2.postMessage(0);
  },
  esp32Rom: () => esp32Rom,
  // Shared memory needs cross-origin isolation (COOP/COEP, set by the dev server and the bridge).
  sharedMemory: crossOriginIsolated,
});

const waiting: ToSim[] = [];
let romSettled = false;
scope.onmessage = (event) => {
  if (romSettled) session.handle(event.data);
  else waiting.push(event.data);
};

fetch('/esp32-rom/esp32_rev0_rom.elf')
  .then(async (response) => (response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined))
  .catch(() => undefined)
  .then((bytes) => {
    esp32Rom = bytes !== undefined && bytes.length > 0 ? bytes : undefined;
    romSettled = true;
    for (const message of waiting.splice(0)) session.handle(message);
  });
