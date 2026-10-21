/**
 * Boots an ESP32 fixture in Node with tracing and prints what happened (BT32's boot debugger):
 *   node scripts/esp32-trace.ts <fixture> [--until <symbol>] [--max-ms N] [--trace N]
 * UART output, both cores' PC/symbol/PS/WINDOWBASE, milestones reached, the top-20 PC histogram
 * per core, the unknown-register and other Problems, the exception log, and the last N (default
 * 64) instructions of each core disassembled and symbolized. Needs the cached ROM
 * (npm run fetch:esp32-rom).
 */

import { BOOT_MILESTONES, bootFixture, runUntil } from '../packages/esp32/src/test-support/boot.test-helper.ts';
import { decode, DESCRIPTOR_SIZE } from '../packages/esp32/src/xtensa/decode.ts';
import { disasm } from '../packages/esp32/src/xtensa/disasm.ts';
import { SR } from '../packages/esp32/src/xtensa/regs.ts';

const args = process.argv.slice(2);
const fixture = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (fixture === undefined) {
  console.error('usage: node scripts/esp32-trace.ts <fixture> [--until <symbol>] [--max-ms N] [--trace N]');
  process.exit(1);
}
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const until = option('--until');
const maxMs = Number(option('--max-ms') ?? '3000');
const depth = Number(option('--trace') ?? '64');
const milestones = until !== undefined && !(BOOT_MILESTONES as readonly string[]).includes(until) ? [...BOOT_MILESTONES, until] : BOOT_MILESTONES;

const { soc, symbols, tracer, uart } = bootFixture(fixture, { trace: true, milestones });
if (tracer === null) throw new Error('no tracer');
const started = performance.now();
runUntil(soc, maxMs / 1000, () => until !== undefined && tracer.reachedMilestone(until));
const wall = (performance.now() - started) / 1000;
const hex = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
const instructions = soc.cores[0].instructions + soc.cores[1].instructions;

console.log(`== ${fixture}: ${soc.seconds().toFixed(4)} s simulated in ${wall.toFixed(2)} s wall, ${instructions.toLocaleString('en-US')} instructions (${(instructions / wall / 1e6).toFixed(1)} MIPS), CPU ${soc.cpuHz / 1e6} MHz`);
if (soc.stopped) console.log(`STOPPED: ${soc.stopReason}`);
console.log('\n== UART0');
console.log(JSON.stringify(uart[0]));
console.log('\n== cores');
soc.cores.forEach((core, cpu) => {
  const running = cpu === 0 || soc.appRunning;
  console.log(
    `${cpu === 0 ? 'PRO' : 'APP'}: ${running ? '' : '(in reset) '}pc ${hex(core.pc)} ${symbols.symbolize(core.pc)} ps ${hex(core.ps)} wb ${core.windowBase} ws ${hex(core.windowStart)} intenable ${hex(core.intenable)} interrupt ${hex(core.interrupt)} ccount ${core.ccount} vecbase ${hex(core.readSpecial(SR.VECBASE))}`,
  );
});
console.log('\n== milestones');
for (const m of tracer.milestones) console.log(`${m.seconds.toFixed(6)} s  ${m.cpu === 0 ? 'PRO' : 'APP'}  ${m.name}`);
for (let cpu = 0; cpu < 2; cpu++) {
  console.log(`\n== histogram ${cpu === 0 ? 'PRO' : 'APP'} (samples every 1,024 instructions)`);
  for (const h of tracer.histogram(cpu, symbols)) console.log(`${String(h.samples).padStart(8)}  ${h.name}`);
}
console.log(`\n== problems (${soc.problems.problems.length}; totals ${JSON.stringify(Object.fromEntries(soc.problems.totals))})`);
for (const p of soc.problems.problems) {
  const at = /at PC (0x[0-9A-F]+)/.exec(p.message);
  console.log(`${p.code}: ${p.message}${at === null ? '' : `  [${symbols.symbolize(Number.parseInt(at[1], 16))}]`}`);
}
console.log(`\n== exceptions (${tracer.exceptionCount}; window overflow/underflow and level-1 interrupts not logged)`);
const causes = new Map<string, number>();
for (const e of tracer.exceptions) causes.set(String(e.cause), (causes.get(String(e.cause)) ?? 0) + 1);
console.log(`by cause: ${JSON.stringify(Object.fromEntries(causes))}`);
for (const e of tracer.exceptions.slice(0, 40)) {
  console.log(`${e.seconds.toFixed(6)} s ${e.cpu === 0 ? 'PRO' : 'APP'} cause ${e.cause} pc ${hex(e.pc)} ${symbols.symbolize(e.pc)} vaddr ${hex(e.vaddr)}`);
}
const d = new Int32Array(DESCRIPTOR_SIZE);
for (let cpu = 0; cpu < 2; cpu++) {
  console.log(`\n== last ${depth} instructions, ${cpu === 0 ? 'PRO' : 'APP'}`);
  for (const t of tracer.last(cpu, depth)) {
    decode(t.word & 0xff, (t.word >>> 8) & 0xff, (t.word >>> 16) & 0xff, d);
    console.log(`${hex(t.pc)}  ${(symbols.symbolize(t.pc) + '').padEnd(36)} ${(disasm(d, t.pc) ?? '.byte').replace('\t', ' ').padEnd(36)} a1 ${hex(t.a1)}`);
  }
}
