/**
 * Boots an ESP32-C3 fixture in Node and shows what happened (BT92; like esp32-trace.ts):
 *   node scripts/esp32c3-trace.ts <fixture> [--ms N] [--hist N] [--last N] [--dis N]
 * UART0's output, the core's state, the PCs it spent the most time at (symbolized from the
 * fixture's .syms.tsv), the Problems (unknown registers first), with --last the PCs of the last
 * N 10 µs samples, and with --dis the stop PC's function disassembled from its start to N
 * instructions past the PC. Needs the C3 ROM (npm run fetch:esp32-rom).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { C3_ROM_CACHE_DIR, C3_ROM_ELF_NAME, directBoot, Esp32c3Soc, parseC3Rom, REF_HZ } from '../packages/esp32c3/src/index.ts';
import { disassemble, RV32IMAC } from '../packages/riscv/src/index.ts';

const args = process.argv.slice(2);
const name = args[0];
if (name === undefined) {
  console.error('usage: node scripts/esp32c3-trace.ts <fixture> [--ms N] [--hist N] [--last N]');
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
const dir = join(root, 'fixtures/firmware/esp32c3');
const rom = parseC3Rom(new Uint8Array(readFileSync(join(root, C3_ROM_CACHE_DIR, C3_ROM_ELF_NAME))));
const soc = new Esp32c3Soc();
const booted = directBoot(soc, { app: new Uint8Array(readFileSync(join(dir, `${name}.bin`))), partitions: new Uint8Array(readFileSync(join(dir, `${name}.partitions.bin`))), rom });
if (!booted.ok) throw new Error(booted.error);

// Symbols: the app's and the ROM's.
const syms: [number, number, string][] = [];
for (const line of readFileSync(join(dir, `${name}.syms.tsv`), 'utf8').split('\n')) {
  const [a, s, t, n] = line.split('\t');
  if (n === undefined || !/[tTwW]/.test(t)) continue;
  syms.push([Number.parseInt(a, 16), s === '' ? 0 : Number.parseInt(s, 16), n]);
}
for (const [n, a] of rom.symbols) if (a >= 0x40000000 && a < 0x40060000) syms.push([a, 0, n]);
syms.sort((x, y) => x[0] - y[0]);
const symbolAt = (pc: number): number => {
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
  return best;
};
const symbolize = (pc: number): string => {
  const best = symbolAt(pc);
  return best < 0 ? `0x${pc.toString(16)}` : `${syms[best][2]}+0x${(pc - syms[best][0]).toString(16)}`;
};

let uart = '';
soc.uarts[0].onTx = (b) => (uart += String.fromCharCode(b));
const hist = new Map<string, number>();
const ring = new Uint32Array(Math.max(1, last));
let ringAt = 0;
const step = REF_HZ / 100_000; // 10 µs
const end = (ms * REF_HZ) / 1000;
const start = Date.now();
while (soc.time < end && !soc.stopped) {
  soc.runUntil(Math.min(end, soc.time + step));
  const pc = soc.core.pc >>> 0;
  const where = symbolize(pc).replace(/\+0x[0-9a-f]+$/, '');
  hist.set(where, (hist.get(where) ?? 0) + 1);
  if (last > 0) ring[ringAt++ % last] = pc;
}
const wall = Date.now() - start;
console.log(`--- UART0 (${uart.length} bytes) ---\n${uart}\n---`);
console.log(`time ${(soc.time / REF_HZ * 1000).toFixed(3)} ms, wall ${wall} ms, cpu ${soc.cpuHz / 1e6} MHz, instructions ${soc.core.instructions}, ${soc.stopped ? `STOPPED: ${soc.stopReason}` : 'running'}`);
console.log(`pc ${symbolize(soc.core.pc >>> 0)} (0x${(soc.core.pc >>> 0).toString(16)}) waiting=${soc.core.waiting} mstatus=0x${soc.core.mstatus.toString(16)} mcause=0x${(soc.core.mcause >>> 0).toString(16)} mepc=${symbolize(soc.core.mepc >>> 0)} cause=${soc.matrix.current}`);
console.log('--- where the time went ---');
for (const [k, v] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, histTop)) console.log(`${String(v).padStart(7)}  ${k}`);
console.log(`--- problems (${soc.problems.problems.length}) ---`);
for (const p of soc.problems.problems.slice(0, 60)) console.log(`${p.severity} ${p.code}: ${p.message}`);
if (last > 0) {
  console.log('--- last samples ---');
  for (let i = 0; i < last; i++) console.log(symbolize(ring[(ringAt + i) % last]));
}
if (dis > 0) {
  const pc = soc.core.pc >>> 0;
  const best = symbolAt(pc);
  let at = best < 0 || pc - syms[best][0] > 0x2000 ? pc : syms[best][0];
  console.log(`--- ${best < 0 ? 'around the PC' : syms[best][2]} ---`);
  for (let after = 0; after <= dis; ) {
    let word: number;
    try {
      word = soc.bus.read32(at);
    } catch {
      break;
    }
    const d = disassemble(word, at, RV32IMAC);
    console.log(`${at === pc ? '>' : ' '} ${at.toString(16)}  ${d.mnemonic} ${d.operands}`);
    if (at >= pc) after++;
    at += d.length;
  }
}
