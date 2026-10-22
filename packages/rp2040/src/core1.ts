/**
 * The RP2040's core 1 (BT80). rp2040js emulates one Cortex-M0+ and reads `rp.core` (and
 * `rp.ppb`) wherever a core matters: the PPB's NVIC registers and SysTick, the SIO's CPUID and
 * divider, `setInterrupt`. `DualCore` adds a second core on the same chip and makes those per
 * core (datasheet §2.3.1 SIO, §2.4.8 NVIC):
 *
 * - Each core has its own PPB: rp2040js's `RPPPB` reads `this.rp2040.core`, so each PPB gets a
 *   view of the chip whose `core` is fixed to its own core (SysTick fires into its own core).
 *   While a core executes, `rp.core` and `rp.ppb` are its own (`switchTo`).
 * - A peripheral's IRQ line reaches both cores' NVICs (each enables its own); SIO_IRQ_PROC0/1
 *   (the FIFOs) only their own core.
 * - The SIO: CPUID reads the executing core; each core has an RX FIFO, 8 words deep, written by
 *   the other core, with FIFO_ST's VLD/RDY and the sticky WOF/ROE flags (write 1 to clear); the
 *   divider and the interpolators are per core (their state is swapped with the core).
 *   Spinlocks, GPIO and every peripheral are shared, as on the chip.
 * - Core 1 starts in the bootrom's wait for a launch (§2.8.2), played here: released from reset
 *   (PSM FRCE_OFF.proc1 cleared) it pushes a 0 to core 0; it echoes each word of the launch
 *   sequence (0, 0, 1, vector table, stack pointer, entry) and then starts at the entry with
 *   that VTOR and SP. Forcing it off again puts it back into the wait.
 * - SEV on either core (once core 1 runs) sets both cores' event flags and wakes a WFE.
 *
 * Not modeled: IO_BANK0's per-core interrupt enables (PROC1_INTE…; rp2040js has PROC0's only —
 * core 1 sees bank 0's interrupt line like any other).
 */

import type { RP2040 } from 'rp2040js';
import type { FastCore, StockCore } from './m0/fast-core.ts';

// SIO (datasheet §2.3.1.7).
const SIO_CPUID = 0x000;
const FIFO_ST = 0x50;
const FIFO_WR = 0x54;
const FIFO_RD = 0x58;
const ST_VLD = 0x1;
const ST_RDY = 0x2;
const ST_WOF = 0x4;
const ST_ROE = 0x8;
/** Each FIFO is 8 words deep. */
export const FIFO_DEPTH = 8;
/** SIO_IRQ_PROC0 and SIO_IRQ_PROC1 (datasheet §2.3.2). */
const SIO_IRQ = [15, 16] as const;
/** The PSM's FRCE_OFF register and its core 1 bit (datasheet §2.13). */
const PSM_BASE = 0x40010000;
const PSM_FRCE_OFF = 0x04;
const PSM_PROC1 = 1 << 16;

/** rp2040js's SIO fields that are per core on the chip (the divider; the interpolators). */
interface SioCoreState {
  divDividend: number;
  divDivisor: number;
  divQuotient: number;
  divRemainder: number;
  divCSR: number;
  interp0: unknown;
  interp1: unknown;
}

type Core = StockCore & { eventRegistered: boolean; waiting: boolean };
type Ppb = RP2040['ppb'];

export interface DualCoreHooks {
  /** A core that isn't installed yet: a fresh one of the chip's kind (fast or stock). */
  createCore(): StockCore;
  /** Core 1 was launched at `entry` (for tests and logs). */
  onLaunch?(entry: number): void;
}

export class DualCore {
  readonly cores: [Core, Core];
  readonly ppbs: [Ppb, Ppb];
  /** The core executing now (0 or 1): `rp.core`, `rp.ppb` and the SIO state are its own. */
  current = 0;
  /** Core 1 runs (launched and not held in reset). */
  launched = false;
  private readonly rp: RP2040;
  private readonly hooks: DualCoreHooks;
  private readonly views: [RP2040, RP2040];
  /** Each core's RX FIFO (written by the other core). */
  private readonly rx: [number[], number[]] = [[], []];
  /** Each core's sticky WOF/ROE flags. */
  private readonly sticky = [0, 0];
  /** The launch sequence core 1's bootrom has seen (zeros restart it). */
  private readonly sequence: number[] = [];
  /** Each core's divider and interpolator state while the other core executes. */
  private readonly saved: [SioCoreState, SioCoreState];

  constructor(rp: RP2040, hooks: DualCoreHooks) {
    this.rp = rp;
    this.hooks = hooks;
    const core0 = rp.core as Core;
    const core1 = hooks.createCore() as Core;
    this.cores = [core0, core1];
    const view = (core: Core): RP2040 => Object.create(rp, { core: { get: () => core } }) as RP2040;
    // A view per core: core 1's is re-pointed when a reset gives it a new core.
    this.views = [view(core0), Object.create(rp, { core: { get: () => this.cores[1] } }) as RP2040];
    const ppb0 = rp.ppb;
    (ppb0 as unknown as { rp2040: RP2040 }).rp2040 = this.views[0];
    const PpbClass = ppb0.constructor as new (rp2040: RP2040, name: string) => Ppb;
    this.ppbs = [ppb0, new PpbClass(this.views[1], 'PPB1')];
    this.saved = [freshSioState(rp), freshSioState(rp)];

    rp.setInterrupt = (irq: number, value: boolean) => {
      this.cores[0].setInterrupt(irq, value);
      this.cores[1].setInterrupt(irq, value);
    };
    const sio = rp.sio;
    const read = sio.readUint32.bind(sio);
    const write = sio.writeUint32.bind(sio);
    sio.readUint32 = (offset: number) => {
      switch (offset) {
        case SIO_CPUID:
          return this.current;
        case FIFO_ST:
          return this.status(this.current);
        case FIFO_RD: {
          const c = this.current;
          const fifo = this.rx[c];
          if (fifo.length === 0) {
            this.sticky[c] |= ST_ROE;
            this.updateIrq(c);
            return 0;
          }
          const value = fifo.shift() as number;
          this.updateIrq(c);
          return value;
        }
        default:
          return read(offset);
      }
    };
    sio.writeUint32 = (offset: number, value: number) => {
      switch (offset) {
        case FIFO_ST: {
          const c = this.current;
          this.sticky[c] &= ~(value & (ST_WOF | ST_ROE));
          this.updateIrq(c);
          return;
        }
        case FIFO_WR:
          this.fifoWrite(this.current, value >>> 0);
          return;
        case SIO_CPUID:
          return;
        default:
          write(offset, value);
      }
    };
    const psm = rp.findPeripheral(PSM_BASE);
    const psmRead = psm.readUint32.bind(psm);
    const psmWrite = psm.writeUint32.bind(psm);
    psm.writeUint32 = (offset: number, value: number) => {
      const before = psmRead(PSM_FRCE_OFF) & PSM_PROC1;
      psmWrite(offset, value);
      const after = psmRead(PSM_FRCE_OFF) & PSM_PROC1;
      if (before === 0 && after !== 0) this.holdCore1();
      else if (before !== 0 && after === 0) this.releaseCore1();
    };
  }

  /** FIFO_ST as core `c` reads it. */
  private status(c: number): number {
    return (this.rx[c].length > 0 ? ST_VLD : 0) | (this.rx[1 - c].length < FIFO_DEPTH ? ST_RDY : 0) | this.sticky[c];
  }

  /** SIO_IRQ_PROCn: core n's RX FIFO holds data, or a sticky error is set. */
  private updateIrq(c: number): void {
    this.cores[c].setInterrupt(SIO_IRQ[c], this.rx[c].length > 0 || this.sticky[c] !== 0);
  }

  private fifoWrite(c: number, value: number): void {
    if (c === 0 && !this.launched) {
      this.bootromReceive(value);
      return;
    }
    const to = 1 - c;
    if (this.rx[to].length >= FIFO_DEPTH) {
      this.sticky[c] |= ST_WOF;
      this.updateIrq(c);
      return;
    }
    this.rx[to].push(value);
    this.updateIrq(to);
  }

  /** Core 1's bootrom: echo each word; a full sequence launches. */
  private bootromReceive(value: number): void {
    if (value === 0) this.sequence.length = 0;
    else this.sequence.push(value);
    this.bootromPush(value);
    if (this.sequence.length === 4 && this.sequence[0] === 1) {
      const [, vectorTable, sp, entry] = this.sequence;
      this.sequence.length = 0;
      this.launch(vectorTable, sp, entry);
    }
  }

  /** A word from core 1's bootrom to core 0, with the SEV that follows it. */
  private bootromPush(value: number): void {
    if (this.rx[0].length < FIFO_DEPTH) this.rx[0].push(value >>> 0);
    this.updateIrq(0);
    this.cores[0].eventRegistered = true;
  }

  private launch(vectorTable: number, sp: number, entry: number): void {
    const core = this.cores[1];
    core.VTOR = vectorTable >>> 0;
    core.SP = sp >>> 0;
    core.PC = (entry & ~1) >>> 0;
    core.waiting = false;
    this.rx[1].length = 0;
    this.launched = true;
    this.events(true);
    this.hooks.onLaunch?.(entry >>> 0);
  }

  /** SEV reaches the other core while core 1 runs (a fast core's hook; rp2040js's SEV only logs). */
  private events(on: boolean): void {
    for (const core of this.cores) (core as unknown as FastCore).onSev = on ? this.sevHook : null;
  }

  private readonly sevHook = (): void => this.sev();

  /** PSM forced core 1 off: it stops (a fresh core waits for the next release). */
  private holdCore1(): void {
    this.launched = false;
    this.events(false);
    if (this.current === 1) return; // a core can't force itself off mid-instruction; it ends when control returns
    this.replaceCore1();
  }

  /** Released from reset: core 1's bootrom drains its FIFO and pushes a 0. */
  private releaseCore1(): void {
    this.launched = false;
    this.events(false);
    this.replaceCore1();
    this.sequence.length = 0;
    this.rx[0].length = 0;
    this.rx[1].length = 0;
    this.sticky[0] = 0;
    this.sticky[1] = 0;
    this.updateIrq(1);
    this.bootromPush(0);
  }

  private replaceCore1(): void {
    const fresh = this.hooks.createCore() as Core;
    this.cores[1] = fresh;
    const ppb1 = this.ppbs[1];
    // the PPB's registers belong to the core (NVIC) or are reset with it (SysTick)
    ppb1.reset();
    if (this.current === 1) (this.rp as { core: StockCore }).core = fresh;
  }

  /** Makes core `c` the executing one: `rp.core`, `rp.ppb` and the SIO's per-core state. */
  switchTo(c: number): void {
    if (c === this.current) return;
    const sio = this.rp.sio as unknown as SioCoreState;
    copySio(sio, this.saved[this.current]);
    copySio(this.saved[c], sio);
    (this.rp as { core: StockCore }).core = this.cores[c];
    (this.rp as { ppb: Ppb }).ppb = this.ppbs[c];
    this.current = c;
  }

  /** SEV: both cores' event flags; a core asleep in WFE wakes. */
  sev(): void {
    for (const core of this.cores) {
      core.eventRegistered = true;
      if (core.waiting && (core as unknown as FastCore).wfe === true) {
        core.waiting = false;
        core.eventRegistered = false; // the WFE consumes it
      }
    }
  }

  /** clk_sys changed: both SysTicks count at the new rate. */
  setClock(hz: number): void {
    for (const ppb of this.ppbs) ppb.systickTimer.frequency = hz;
  }
}

function copySio(from: SioCoreState, to: SioCoreState): void {
  to.divDividend = from.divDividend;
  to.divDivisor = from.divDivisor;
  to.divQuotient = from.divQuotient;
  to.divRemainder = from.divRemainder;
  to.divCSR = from.divCSR;
  to.interp0 = from.interp0;
  to.interp1 = from.interp1;
}

/** The divider and interpolators as they are after reset, for the core not executing. */
function freshSioState(rp: RP2040): SioCoreState {
  const sio = rp.sio as unknown as SioCoreState;
  const Interp = (sio.interp0 as { constructor: new (index: number) => unknown }).constructor;
  return { divDividend: 0, divDivisor: 1, divQuotient: 0, divRemainder: 0, divCSR: 0, interp0: new Interp(0), interp1: new Interp(1) };
}
