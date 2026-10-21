/**
 * The interrupt matrix (TRM v5.8 ch. 8; dport_reg.h): 69 peripheral interrupt sources, each
 * routed per CPU to one of its 32 interrupts by a map register — PRO at DPORT 0x104 + 4·source,
 * APP at 0x218 + 4·source (reset value 16). Sources are level lines here; a CPU interrupt is high
 * while any source mapped to it is high. Only the CPU's external interrupts take sources:
 * mapping a source to an internal one (6, 7, 11, 15, 16, 29 — timers, software, profiling) is
 * how IDF disables it, and has no effect. Edge-type CPU interrupts (10, 22, 28, 30) see a pulse
 * on a rising edge. PRO/APP_INTR_STATUS_0..2 show the raw source lines.
 *
 * Sources 22 and 23 are CPU-specific (TRM v5.8 §7.3: GPIO_INTERRUPT_PRO/_PRO_NMI reach only the
 * PRO_CPU's map, GPIO_INTERRUPT_APP/_APP_NMI only the APP_CPU's): `setCpuSource` drives them.
 */

import type { XtensaCore } from '../xtensa/cpu.ts';
import * as irq from '../xtensa/interrupts.ts';
import type { InterruptSink } from './context.ts';

export const SOURCE_COUNT = 69;
const EXTERNAL = (irq.INT_MASK.EXTERN_LEVEL | irq.INT_MASK.EXTERN_EDGE | irq.INT_MASK.NMI) >>> 0;
const EDGE = irq.INT_MASK.EXTERN_EDGE;

export class InterruptMatrix implements InterruptSink {
  /** map[cpu][source] = the CPU interrupt (0–31) the source drives. */
  readonly map = [new Uint8Array(SOURCE_COUNT).fill(16), new Uint8Array(SOURCE_COUNT).fill(16)];
  /** Raw source lines. */
  readonly lines = new Uint8Array(SOURCE_COUNT);
  /** CPU-specific source lines (GPIO 22/23), per CPU. */
  readonly cpuLines = [new Uint8Array(SOURCE_COUNT), new Uint8Array(SOURCE_COUNT)];
  /** The two CPUs (set once the SoC has built them). */
  cores: readonly XtensaCore[] = [];
  /** CPU interrupt lines currently driven high, per CPU. */
  private readonly driven = new Uint32Array(2);

  setSource(source: number, high: boolean): void {
    const v = high ? 1 : 0;
    if (this.lines[source] === v) return;
    this.lines[source] = v;
    this.update(0);
    this.update(1);
  }

  /** A source line only CPU `cpu` sees (GPIO_INTERRUPT_PRO/APP and their NMIs). */
  setCpuSource(cpu: number, source: number, high: boolean): void {
    const v = high ? 1 : 0;
    if (this.cpuLines[cpu][source] === v) return;
    this.cpuLines[cpu][source] = v;
    this.update(cpu);
  }

  /** A chip reset: every map back to 16, every line low, nothing driven into the cores. */
  reset(): void {
    this.map[0].fill(16);
    this.map[1].fill(16);
    this.lines.fill(0);
    this.cpuLines[0].fill(0);
    this.cpuLines[1].fill(0);
    this.driven.fill(0);
    for (const core of this.cores) core.lines = 0;
  }

  setMap(cpu: number, source: number, cpuInterrupt: number): void {
    this.map[cpu][source] = cpuInterrupt & 31;
    this.update(cpu);
  }

  /** CPU `cpu`'s INTR_STATUS word `word` (0–2): raw lines of sources 32·word … 32·word + 31. */
  status(cpu: number, word: number): number {
    const own = this.cpuLines[cpu];
    let v = 0;
    for (let i = 0; i < 32; i++) {
      const s = word * 32 + i;
      if (s < SOURCE_COUNT && (this.lines[s] | own[s]) !== 0) v |= 1 << i;
    }
    return v >>> 0;
  }

  private update(cpu: number): void {
    const map = this.map[cpu];
    const own = this.cpuLines[cpu];
    let high = 0;
    for (let s = 0; s < SOURCE_COUNT; s++) if ((this.lines[s] | own[s]) !== 0) high |= 1 << map[s];
    high = (high & EXTERNAL) >>> 0;
    const before = this.driven[cpu];
    if (high === before) return;
    this.driven[cpu] = high;
    const core = this.cores[cpu];
    if (core === undefined) return;
    const changed = (high ^ before) >>> 0;
    for (let n = 0; n < 32; n++) {
      if (((changed >>> n) & 1) === 0) continue;
      const on = ((high >>> n) & 1) !== 0;
      if (((EDGE >>> n) & 1) !== 0) {
        if (on) core.pulseInterrupt(n);
      } else core.setInterruptLine(n, on);
    }
  }
}
