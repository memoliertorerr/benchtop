/**
 * ESP32 interpreter benchmark (BT37): boots three fixtures on the cached ROM and prints, per
 * workload, instructions per core, simulated MIPS (both cores), wall time and simulated time as
 * % of real time — the best of `--repeat` runs (default 3) in one process, with the first (cold:
 * the JIT still warming up) run's wall time beside it:
 *   serial-hello  boot to the first UART0 byte
 *   blink         10 s simulated (WAITI skip-ahead on)
 *   crc-bench     boot to its "crc=…" line
 *   npm run bench:esp32 -- [--icache on|off] [--slice N] [--only name] [--repeat N]
 * Not part of verify (wall time depends on the machine). Needs the cached ROM
 * (npm run fetch:esp32-rom) and the committed fixture firmware.
 */

import { REF_HZ } from '../packages/esp32/src/soc/context.ts';
import type { Esp32Soc } from '../packages/esp32/src/soc/soc.ts';
import { bootFixture, runUntil } from '../packages/esp32/src/test-support/boot.test-helper.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const icache = (option('--icache') ?? 'on') !== 'off';
const slice = option('--slice');
const only = option('--only');
const repeat = Math.max(1, Number(option('--repeat') ?? '3'));

interface Workload {
  name: string;
  what: string;
  run: (soc: Esp32Soc, uart: string[]) => void;
}

const WORKLOADS: Workload[] = [
  { name: 'serial-hello', what: 'boot to first UART byte', run: (soc, uart) => runUntil(soc, 3, () => uart[0].length > 0) },
  { name: 'blink', what: '10 s simulated', run: (soc) => void soc.runUntil(10 * REF_HZ) },
  { name: 'crc-bench', what: 'boot to its output line', run: (soc, uart) => runUntil(soc, 5, () => uart[0].includes('\n')) },
];

interface Row {
  pro: number;
  app: number;
  simulated: number;
  wall: number;
}

function measure(workload: Workload): Row {
  const { soc, uart } = bootFixture(workload.name);
  soc.setPredecode(icache);
  if (slice !== undefined) soc.sliceCycles = Number(slice);
  const started = performance.now();
  workload.run(soc, uart);
  const wall = (performance.now() - started) / 1000;
  if (soc.stopped) throw new Error(`${workload.name} stopped: ${soc.stopReason}`);
  return { pro: soc.cores[0].instructions, app: soc.cores[1].instructions, simulated: soc.seconds(), wall };
}

const n = (v: number): string => v.toLocaleString('en-US');
console.log(`ESP32 bench — predecode cache ${icache ? 'on' : 'off'}, slice ${slice ?? 256}, best of ${repeat}, Node ${process.version}`);
console.log('| workload | run | PRO instructions | APP instructions | MIPS | wall s | % of real time | cold wall s |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|');
for (const workload of WORKLOADS) {
  if (only !== undefined && workload.name !== only) continue;
  const rows: Row[] = [];
  for (let i = 0; i < repeat; i++) rows.push(measure(workload));
  const best = rows.reduce((a, b) => (b.wall < a.wall ? b : a));
  const mips = (best.pro + best.app) / best.wall / 1e6;
  console.log(
    `| ${workload.name} | ${workload.what} | ${n(best.pro)} | ${n(best.app)} | ${mips.toFixed(1)} | ${best.wall.toFixed(2)} | ${((best.simulated / best.wall) * 100).toFixed(1)} % | ${rows[0].wall.toFixed(2)} |`,
  );
}
