/**
 * The perf budget's measurement (BT40), run by perf.test.ts in a plain `node` process: Vitest's
 * module transform rewrites every imported call into a property lookup, which halves the
 * CPU core's speed in its hot loop, while the browser runs the bundled worker with direct
 * bindings — as plain Node does. Prints one JSON line: simulated, wall and CPU time, both
 * ratios, and how often each LED flipped. CPU time is what the run needed from its core: the
 * browser's worker has a core to itself, while a full test run shares every core.
 *
 * The session runs `fixtures/projects/<project>.json` with blink at speed Max on the real
 * clock, posting through the frame ring as in a cross-origin isolated browser.
 */

import { readFileSync } from 'node:fs';
import { NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { FrameRingReader } from './frame-ring.ts';
import { SimSession } from './session.ts';

const root = new URL('../../../../', import.meta.url);
const project = process.argv[2] ?? 'perf-100-leds';
const simulatedMs = Number(process.argv[3] ?? 2000);

const doc = JSON.parse(readFileSync(new URL(`fixtures/projects/${project}.json`, root), 'utf8')) as ProjectDoc;
const hex = readFileSync(new URL('fixtures/firmware/uno/blink.hex', root), 'utf8');

let pending: (() => void) | null = null;
let reader: FrameRingReader | null = null;
let t = 0;
const lit = new Map<string, boolean>();
const flips = new Map<string, number>();
let problems: string[] = [];
const session = new SimSession({
  post: (message) => {
    if (message.type === 'error') throw new Error(message.message);
    if (message.type === 'problems') problems = message.list.map((p) => p.code);
    if (message.type === 'frameRing') reader = new FrameRingReader(message.buffer, message.parts);
    if (message.type !== 'frame') return;
    t = message.t;
    for (const [id, visual] of [...message.parts, ...(reader?.drain() ?? [])]) {
      // Lit: carrying current (100 LEDs on one pin pull it down to ≈ 2.07 V: ≈ 1.2 mA each, dim).
      if (typeof visual.milliamps !== 'number') continue;
      const on = visual.milliamps > 0.5;
      if (lit.has(id) && lit.get(id) !== on) flips.set(id, (flips.get(id) ?? 0) + 1);
      lit.set(id, on);
    }
  },
  now: () => performance.now(),
  schedule: (fn) => {
    pending = fn;
  },
  sharedMemory: true,
});
session.handle({ type: 'load', doc, firmware: { uno: { format: 'hex', text: hex } } });
session.handle({ type: 'run', speed: Number.POSITIVE_INFINITY });
const start = performance.now();
const cpuStart = process.cpuUsage();
while (t < simulatedMs * NS_PER_MS) {
  const fn = pending as (() => void) | null;
  pending = null;
  if (fn === null) throw new Error('the session stopped scheduling ticks');
  fn();
}
const wallMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
const cpuMs = (cpu.user + cpu.system) / 1000;
session.handle({ type: 'pause' });

const leds = doc.parts.filter((p) => p.type === 'led').map((p) => p.id);
process.stdout.write(
  `${JSON.stringify({
    simulatedMs: t / NS_PER_MS,
    wallMs,
    cpuMs,
    ratio: t / NS_PER_MS / wallMs,
    cpuRatio: t / NS_PER_MS / cpuMs,
    leds: leds.length,
    minFlips: Math.min(...leds.map((id) => flips.get(id) ?? 0)),
    ring: reader !== null,
    problems: [...new Set(problems)].sort(),
  })}\n`,
);
