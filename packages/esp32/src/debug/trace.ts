/**
 * Boot debugging (BT32), per SoC: for each core a ring of the last 4,096 instructions (PC, word,
 * a1), a PC histogram sampled every 1,024 instructions, the first time each milestone symbol is
 * reached (simulated seconds), and an exception log of every vector entry except window
 * overflow/underflow and level-1 interrupts (cause, EPC, EXCVADDR). Attaching switches the cores
 * to their instrumented run loop; the normal loop pays nothing when no tracer is attached.
 */

import type { Esp32Soc } from '../soc/soc.ts';
import type { EspSymbols } from './symbols.ts';

export const TRACE_DEPTH = 4096;
const SAMPLE_EVERY = 1024;

export interface Milestone {
  name: string;
  cpu: number;
  seconds: number;
}

export interface ExceptionRecord {
  cpu: number;
  /** EXCCAUSE, or −level for an interrupt above level 1 (−6: debug exception). */
  cause: number;
  pc: number;
  vaddr: number;
  seconds: number;
}

export class SocTracer {
  /** Per core: PC, word, a1 per entry. */
  readonly rings = [new Uint32Array(TRACE_DEPTH * 3), new Uint32Array(TRACE_DEPTH * 3)];
  readonly written = [0, 0];
  readonly samples = [new Map<number, number>(), new Map<number, number>()];
  readonly milestones: Milestone[] = [];
  readonly exceptions: ExceptionRecord[] = [];
  /** Exceptions kept (the rest are only counted). */
  static readonly EXCEPTION_LIMIT = 2000;
  exceptionCount = 0;
  private readonly soc: Esp32Soc;
  private readonly watch = new Map<number, string>();
  private readonly reached = [new Set<number>(), new Set<number>()];
  private readonly counter = [0, 0];

  constructor(soc: Esp32Soc, symbols: EspSymbols, milestones: readonly string[] = []) {
    this.soc = soc;
    for (const name of milestones) {
      const address = symbols.address(name);
      if (address !== undefined) this.watch.set(address, name);
    }
    for (let cpu = 0; cpu < 2; cpu++) {
      const core = soc.cores[cpu];
      const ring = this.rings[cpu];
      const samples = this.samples[cpu];
      const reached = this.reached[cpu];
      core.instructionHook = (pc: number, word: number): void => {
        const i = (this.written[cpu] % TRACE_DEPTH) * 3;
        ring[i] = pc;
        ring[i + 1] = word;
        ring[i + 2] = core.reg(1);
        this.written[cpu]++;
        if (++this.counter[cpu] >= SAMPLE_EVERY) {
          this.counter[cpu] = 0;
          samples.set(pc, (samples.get(pc) ?? 0) + 1);
        }
        const name = this.watch.get(pc);
        if (name !== undefined && !reached.has(pc)) {
          reached.add(pc);
          this.milestones.push({ name, cpu, seconds: soc.seconds() });
        }
      };
      core.exceptionHook = (cause: number, pc: number, vaddr: number): void => {
        this.exceptionCount++;
        if (this.exceptions.length < SocTracer.EXCEPTION_LIMIT) this.exceptions.push({ cpu, cause, pc, vaddr, seconds: soc.seconds() });
      };
    }
  }

  detach(): void {
    for (const core of this.soc.cores) {
      core.instructionHook = null;
      core.exceptionHook = null;
    }
  }

  reachedMilestone(name: string): boolean {
    return this.milestones.some((m) => m.name === name);
  }

  /** The last `count` trace entries of `cpu`, oldest first. */
  last(cpu: number, count: number): { pc: number; word: number; a1: number }[] {
    const n = Math.min(count, this.written[cpu], TRACE_DEPTH);
    const out: { pc: number; word: number; a1: number }[] = [];
    for (let k = this.written[cpu] - n; k < this.written[cpu]; k++) {
      const i = (k % TRACE_DEPTH) * 3;
      out.push({ pc: this.rings[cpu][i], word: this.rings[cpu][i + 1], a1: this.rings[cpu][i + 2] });
    }
    return out;
  }

  /** Histogram samples aggregated by symbol, most first. */
  histogram(cpu: number, symbols: EspSymbols, top = 20): { name: string; samples: number }[] {
    const bySymbol = new Map<string, number>();
    for (const [pc, n] of this.samples[cpu]) {
      const s = symbols.lookup(pc);
      const name = s?.name ?? `0x${pc.toString(16)}`;
      bySymbol.set(name, (bySymbol.get(name) ?? 0) + n);
    }
    return [...bySymbol].map(([name, samples]) => ({ name, samples })).sort((a, b) => b.samples - a.samples).slice(0, top);
  }
}
