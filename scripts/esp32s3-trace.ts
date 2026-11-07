/**
 * Boots an ESP32-S3 fixture in Node and shows what happened (BT124; like esp32c3-trace.ts):
 *   node scripts/esp32s3-trace.ts <fixture> [--ms N] [--hist N] [--last N] [--dis N] [--exc]
 * UART0's output, both cores' state, the PCs they spent the most time at (symbolized from the
 * fixture's .syms.tsv and the ROM), the Problems (unknown registers first), with --last the PCs of
 * the last N 10 µs samples (both cores), with --dis the PRO_CPU's stop PC disassembled N
 * instructions on, and with --exc every exception and interrupt above level 1 the cores take.
 * Needs the S3 ROM (npm run fetch:esp32-rom).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESCRIPTOR_SIZE, decode, disasm } from '../packages/esp32/src/index.ts';
import { directBootS3, Esp32s3Soc, parseS3Rom, REF_HZ, S3_ROM_CACHE_DIR, S3_ROM_ELF_NAME } from '../packages/esp32s3/src/index.ts';

const args = process.argv.slice(2);
const name = args[0];
if (name === undefined) {
  console.error('usage: node scripts/esp32s3-trace.ts <fixture> [--ms N] [--hist N] [--last N] [--dis N] [--exc]');
  process.exit(1);
}
const opt = (flag: string, fallback: number): number => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ms = opt('--ms', 500);
const histTop = opt('--hist', 25);
const last = opt('--last', 0);
const dis = opt('--dis', 0);
const root = join(import.meta.dirname, '..');
const dir = join(root, 'fixtures/firmware/esp32s3');
const rom = parseS3Rom(new Uint8Array(readFileSync(join(root, S3_ROM_CACHE_DIR, S3_ROM_ELF_NAME))));
const soc = new Esp32s3Soc();
const booted = directBootS3(soc, { app: new Uint8Array(readFileSync(join(dir, `${name}.bin`))), partitions: new Uint8Array(readFileSync(join(dir, `${name}.partitions.bin`))), rom });
if (!booted.ok) throw new Error(booted.error);

// Symbols: the app's and the ROM's.
const syms: [number, string][] = [];
for (const line of readFileSync(join(dir, `${name}.syms.tsv`), 'utf8').split('\n')) {
  const [a, , t, n] = line.split('\t');
  if (n === undefined || !/[tTwW]/.test(t)) continue;
  syms.push([Number.parseInt(a, 16), n]);
}
for (const [n, a] of rom.symbols) if (a >= 0x40000000 && a < 0x40060000) syms.push([a, n]);
syms.sort((x, y) => x[0] - y[0]);
const symbolize = (pc: number): string => {
  let lo = 0;
  let hi = syms.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (syms[mid][0] <= pc) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best < 0 ? `0x${pc.toString(16)}` : `${syms[best][1]}+0x${(pc - syms[best][0]).toString(16)}`;
};

let uart = '';
soc.uarts[0].onTx = (b) => (uart += String.fromCharCode(b));
if (args.includes('--exc')) {
  soc.cores.forEach((core, cpu) => {
    core.exceptionHook = (cause, pc, vaddr) => console.log(`cpu${cpu} ${cause < 0 ? `interrupt level ${-cause}` : `exception ${cause}`} at ${symbolize(pc >>> 0)} vaddr 0x${(vaddr >>> 0).toString(16)}`);
  });
}
const hist = new Map<string, number>();
const ring: string[] = [];
const step = REF_HZ / 100_000; // 10 µs
const end = (ms * REF_HZ) / 1000;
const start = Date.now();
while (soc.time < end && !soc.stopped && !soc.resetRequested) {
  soc.runUntil(Math.min(end, soc.time + step));
  for (let cpu = 0; cpu < 2; cpu++) {
    if (cpu === 1 && !soc.appRunning) continue;
    const where = `cpu${cpu} ${symbolize(soc.cores[cpu].pc >>> 0).replace(/\+0x[0-9a-f]+$/, '')}`;
    hist.set(where, (hist.get(where) ?? 0) + 1);
  }
  if (last > 0) {
    ring.push(`${symbolize(soc.cores[0].pc >>> 0)} | ${soc.appRunning ? symbolize(soc.cores[1].pc >>> 0) : '-'}`);
    if (ring.length > last) ring.shift();
  }
}
const wall = Date.now() - start;
console.log(`--- UART0 (${uart.length} bytes) ---\n${uart}\n---`);
console.log(`time ${((soc.time / REF_HZ) * 1000).toFixed(3)} ms, wall ${wall} ms, cpu ${soc.cpuHz / 1e6} MHz, ${soc.stopped ? `STOPPED: ${soc.stopReason}` : soc.resetRequested ? `RESET (reason ${soc.resetReason})` : 'running'}, app cpu ${soc.appRunning ? 'running' : 'held'}`);
for (let cpu = 0; cpu < 2; cpu++) {
  const c = soc.cores[cpu];
  console.log(`cpu${cpu} pc ${symbolize(c.pc >>> 0)} (0x${(c.pc >>> 0).toString(16)}) waiting=${c.waiting} ps=0x${c.ps.toString(16)} intenable=0x${(c.intenable >>> 0).toString(16)} lines=0x${(c.lines >>> 0).toString(16)} cycles ${c.cycles}`);
}
console.log('--- where the time went ---');
for (const [k, v] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, histTop)) console.log(`${String(v).padStart(7)}  ${k}`);
console.log(`--- problems (${soc.problems.problems.length}) ---`);
for (const p of soc.problems.problems.slice(0, 60)) console.log(`${p.severity} ${p.code}: ${p.message}`);
if (last > 0) {
  console.log('--- last samples (cpu0 | cpu1) ---');
  for (const line of ring) console.log(line);
}
if (dis > 0) {
  const d = new Int32Array(DESCRIPTOR_SIZE);
  let at = soc.cores[0].pc >>> 0;
  console.log(`--- from ${symbolize(at)} ---`);
  for (let i = 0; i < dis; i++) {
    const bus = soc.buses[0];
    decode(bus.peek8(at), bus.peek8(at + 1), bus.peek8(at + 2), d, true);
    console.log(`  ${at.toString(16)}  ${disasm(d, at) ?? '?'}`);
    at += d[1] > 0 ? d[1] : 3;
  }
}
