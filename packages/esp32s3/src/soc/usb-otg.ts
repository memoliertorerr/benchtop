/**
 * The ESP32-S3's USB-OTG controller (BT134): a Synopsys DWC2 core (TRM chapter "USB On-The-Go";
 * IDF's usb_reg.h/usb_struct.h), in device mode, slave mode (no DMA), as Arduino's "USB-OTG
 * (TinyUSB)" builds drive it through TinyUSB's dcd_esp32sx. USB0 is at 0x6008_0000: the registers
 * in its first 4 KB, then sixteen 4 KB FIFO windows — window n pushes into IN endpoint n's TX FIFO,
 * any window read pops the shared RX FIFO. Seven IN and seven OUT endpoints (0–6).
 *
 * - Global: GINTSTS's latched bits are write-1-to-clear; RXFLVL (RX FIFO not empty), IEPINT and
 *   OEPINT (DAINT & DAINTMSK), OTGINT, GINNAKEFF and GOUTNAKEFF (DCTL's global NAKs) are derived.
 *   The USB interrupt (S3_SRC.USB) is GAHBCFG's global enable && GINTSTS & GINTMSK. GRSTCTL's FIFO
 *   flushes and core soft reset complete at once (AHBIDL reads 1). GOTGCTL says B-session valid:
 *   the cable is powered.
 * - IN endpoints: DIEPTSIZ's XFRSIZ counts bytes not yet written to the FIFO and PKTCNT packets
 *   not yet sent. Words pushed into an endpoint's window fill the packet in progress, whose size is
 *   min(max packet, XFRSIZ) when its first word arrives; a full packet is queued and XFRSIZ drops
 *   by it (the core's slave-mode bookkeeping). The host's IN token takes the oldest queued packet
 *   (or a zero-length one when XFRSIZ is 0), PKTCNT drops, and at 0 EPENA clears and XFRC rises.
 *   TXFE (DIEPINT bit 7, read-only) is "the FIFO is empty", reaching DAINT only through
 *   DIEPEMPMSK — dcd_esp32sx's refill interrupt.
 * - OUT endpoints: an enabled endpoint without NAK accepts the host's packet: its status (PKTSTS 2,
 *   byte count, endpoint) and data join the RX FIFO, XFRSIZ and PKTCNT drop, and when the transfer
 *   ends (PKTCNT 0 or a short packet) a PKTSTS 3 entry follows, EPENA clears and NAK sets; popping
 *   that entry raises XFRC. SETUP packets always land (PKTSTS 6 with 8 bytes, then PKTSTS 4, whose
 *   pop raises STUP) and clear endpoint 0's STALLs.
 * - DIEPCTL/DOEPCTL: EPENA is set by the firmware and cleared by the core (or EPDIS, raising
 *   EPDISD); CNAK and SNAK clear and set NAKSTS (SNAK raises INEPNE on an IN endpoint); STALL
 *   answers the host's tokens with STALL.
 *
 * The host is the bench's (usb-host.ts), on the other end of the cable: `attached()` is the PHY
 * on the OTG side (RTC_CNTL USB_CONF's SW_HW_USB_PHY_SEL and SW_USB_PHY_SEL set, USB_WRAP's
 * PHY_SEL 0 and pads enabled) with D+ pulled up (DCTL's soft disconnect clear, or USB_WRAP's pull
 * override). Frames (1 ms) start at the firmware's first access to USB0 — a sketch that never
 * touches it costs no events; a change the host waits for (an endpoint enabled, a packet queued,
 * the soft connect) brings its next service forward to HOST_LATENCY from now.
 */

import type { Peripheral } from '@benchtop/esp32';
import type { SocContext } from '@benchtop/esp32c3';
import { USB_ACK, USB_NAK, USB_STALL, type UsbDevicePort, UsbHost } from './usb-host.ts';

export const S3_USB_OTG_BASE = 0x60080000;
/** USB0's 4 KB blocks: the registers, then sixteen FIFO windows. */
export const S3_USB_OTG_BLOCKS = 17;
export const S3_USB_WRAP_BASE = 0x60039000;
const EPS = 7;
/** The host's turnaround for a change it waits on (50 µs). */
const HOST_LATENCY_S = 1 / 20_000;
const FRAME_S = 1 / 1000;

const GOTGCTL = 0x000;
const GOTGINT = 0x004;
const GAHBCFG = 0x008;
const GRSTCTL = 0x010;
const GINTSTS = 0x014;
const GINTMSK = 0x018;
const GRXSTSR = 0x01c;
const GRXSTSP = 0x020;
const GNPTXFSIZ = 0x028;
const DIEPTXF1 = 0x104;
const DCTL = 0x804;
const DSTS = 0x808;
const DIEPMSK = 0x810;
const DOEPMSK = 0x814;
const DAINT = 0x818;
const DAINTMSK = 0x81c;
const DIEPEMPMSK = 0x834;
const DIEP = 0x900;
const DOEP = 0xb00;
const EP_STRIDE = 0x20;
const EP_END = EP_STRIDE * EPS;

export const GINT = {
  CURMOD: 1 << 0,
  OTGINT: 1 << 2,
  SOF: 1 << 3,
  RXFLVL: 1 << 4,
  GINNAKEFF: 1 << 6,
  GOUTNAKEFF: 1 << 7,
  USBSUSP: 1 << 11,
  USBRST: 1 << 12,
  ENUMDNE: 1 << 13,
  IEPINT: 1 << 18,
  OEPINT: 1 << 19,
  RESETDET: 1 << 23,
} as const;
/** GINTSTS bits the core derives; writes don't touch them. */
const GINT_DERIVED = GINT.CURMOD | GINT.OTGINT | GINT.RXFLVL | (1 << 5) | GINT.GINNAKEFF | GINT.GOUTNAKEFF | GINT.IEPINT | GINT.OEPINT | (1 << 24) | (1 << 25) | (1 << 26);
const CTL = { NAKSTS: 1 << 17, STALL: 1 << 21, CNAK: 1 << 26, SNAK: 1 << 27, SETD0PID: 1 << 28, SETD1PID: 1 << 29, EPDIS: 1 << 30, EPENA: 1 << 31 } as const;
/** Write-only DIEPCTL/DOEPCTL bits (never stored). */
const CTL_WRITE_ONLY = CTL.CNAK | CTL.SNAK | CTL.SETD0PID | CTL.SETD1PID;
export const EPINT = { XFRC: 1 << 0, EPDISD: 1 << 1, STUP: 1 << 3, ITTXFE: 1 << 4, INEPNE: 1 << 6, TXFE: 1 << 7, STUPPKTRCVD: 1 << 15 } as const;
const PKTSTS = { OUT_DATA: 2, OUT_DONE: 3, SETUP_DONE: 4, SETUP_DATA: 6 } as const;
const RX_ENTRIES = 64;
const RX_BYTES = 4096;
const TX_BYTES = 1024;

/** One IN endpoint's FIFO: queued packets (lengths) over a byte ring, and the packet being filled. */
class TxFifo {
  readonly bytes = new Uint8Array(TX_BYTES);
  head = 0;
  count = 0;
  readonly lengths = new Uint16Array(16);
  first = 0;
  packets = 0;
  /** The packet being filled: bytes so far and its size (−1: none started). */
  filling = 0;
  target = -1;

  clear(): void {
    this.head = this.count = this.first = this.packets = this.filling = 0;
    this.target = -1;
  }

  get empty(): boolean {
    return this.count === 0 && this.target < 0;
  }
}

export class S3UsbOtg implements UsbDevicePort {
  readonly host: UsbHost;
  private readonly ctx: SocContext;
  private readonly source: number;
  /** RTC_CNTL USB_CONF and USB_WRAP OTG_CONF, as the SoC holds them. */
  private readonly rtcUsbConf: () => number;
  private readonly wrapConf: () => number;
  private readonly regs = new Uint32Array(1024);
  private intsts = 0;
  private globalInNak = false;
  private globalOutNak = false;
  private readonly diepctl = new Uint32Array(EPS);
  private readonly diepint = new Uint32Array(EPS);
  private readonly dieptsiz = new Uint32Array(EPS);
  private readonly doepctl = new Uint32Array(EPS);
  private readonly doepint = new Uint32Array(EPS);
  private readonly doeptsiz = new Uint32Array(EPS);
  private readonly tx: TxFifo[] = [];
  /** RX FIFO: status words and their data, in order. */
  private readonly rxStatus = new Uint32Array(RX_ENTRIES);
  private readonly rxOffset = new Uint16Array(RX_ENTRIES);
  private rxFirst = 0;
  private rxEntries = 0;
  private readonly rxBytes = new Uint8Array(RX_BYTES);
  private rxWrite = 0;
  /** The popped entry whose data the FIFO windows read. */
  private readOffset = 0;
  private readLeft = 0;
  private frames = false;
  private frameNumber = 0;
  private readonly frameSlot: number;
  private readonly hostSlot: number;
  private hostAt = -1;
  private readonly hostLatency: number;
  private readonly framePeriod: number;
  /** The blocks the peripheral map registers (registers, then the FIFO windows). */
  readonly blocks: Peripheral[] = [];

  constructor(ctx: SocContext, source: number, rtcUsbConf: () => number, wrapConf: () => number) {
    this.ctx = ctx;
    this.source = source;
    this.rtcUsbConf = rtcUsbConf;
    this.wrapConf = wrapConf;
    for (let i = 0; i < EPS; i++) this.tx.push(new TxFifo());
    this.hostLatency = ctx.refHz * HOST_LATENCY_S;
    this.framePeriod = ctx.refHz * FRAME_S;
    this.frameSlot = ctx.events.add(() => this.frame());
    this.hostSlot = ctx.events.add(() => {
      this.hostAt = -1;
      this.host.service();
    });
    this.host = new UsbHost(this);
    this.blocks.push({ read32: (o) => this.readReg(o), write32: (o, v) => this.writeReg(o, v), systemReset: () => this.reset() });
    for (let w = 0; w < 16; w++) {
      this.blocks.push({ read32: () => this.popData(), write32: (_o, v) => this.pushData(w, v) });
    }
    this.reset();
  }

  /** Frames are running: the firmware has touched USB0. */
  get active(): boolean {
    return this.frames;
  }

  /** Back to the reset state (a chip reset or GRSTCTL's core soft reset). */
  reset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = this.ctx.regDefault(S3_USB_OTG_BASE + i * 4);
    this.intsts = 0;
    this.globalInNak = this.globalOutNak = false;
    for (let n = 0; n < EPS; n++) {
      this.diepctl[n] = n === 0 ? 1 << 15 : 0;
      this.doepctl[n] = n === 0 ? 1 << 15 : 0;
      this.diepint[n] = this.doepint[n] = this.dieptsiz[n] = this.doeptsiz[n] = 0;
      this.tx[n].clear();
    }
    this.rxFirst = this.rxEntries = this.rxWrite = this.readLeft = this.readOffset = 0;
    this.update();
  }

  // ── The firmware's side ───────────────────────────────────────────────────────────────

  private readReg(offset: number): number {
    this.start();
    if (offset >= DIEP && offset < DIEP + EP_END) return this.readEp(this.diepctl, this.diepint, this.dieptsiz, offset - DIEP, true);
    if (offset >= DOEP && offset < DOEP + EP_END) return this.readEp(this.doepctl, this.doepint, this.doeptsiz, offset - DOEP, false);
    switch (offset) {
      case GOTGCTL:
        return (this.regs[GOTGCTL >>> 2] | (1 << 16) | (1 << 18) | (1 << 19)) >>> 0; // CONIDSTS (B-device), ASESVLD, BSESVLD
      case GRSTCTL:
        return ((this.regs[GRSTCTL >>> 2] & ~0x31) | (1 << 31)) >>> 0; // flushes and soft reset done; AHB idle
      case GINTSTS:
        return this.gintsts();
      case GRXSTSR:
        return this.rxEntries > 0 ? this.rxStatus[this.rxFirst] : 0;
      case GRXSTSP:
        return this.popStatus();
      case DCTL:
        return ((this.regs[DCTL >>> 2] & ~0xc) | (this.globalInNak ? 1 << 2 : 0) | (this.globalOutNak ? 1 << 3 : 0)) >>> 0;
      case DSTS:
        return ((this.regs[DSTS >>> 2] & 0x7) | (this.frameNumber << 8)) >>> 0;
      case DAINT:
        return this.daint();
      default:
        return this.regs[offset >>> 2];
    }
  }

  private writeReg(offset: number, value: number): void {
    this.start();
    if (offset >= DIEP && offset < DIEP + EP_END) {
      this.writeEp(offset - DIEP, value, true);
      return;
    }
    if (offset >= DOEP && offset < DOEP + EP_END) {
      this.writeEp(offset - DOEP, value, false);
      return;
    }
    switch (offset) {
      case GOTGINT:
        this.regs[GOTGINT >>> 2] &= ~value;
        break;
      case GRSTCTL:
        if ((value & 1) !== 0) {
          this.reset();
          return;
        }
        if ((value & (1 << 4)) !== 0) this.rxFirst = this.rxEntries = this.rxWrite = this.readLeft = 0;
        if ((value & (1 << 5)) !== 0) {
          const fifo = (value >>> 6) & 0x1f;
          for (let n = 0; n < EPS; n++) if (fifo === 0x10 || this.txFifoOf(n) === fifo) this.tx[n].clear();
        }
        this.regs[GRSTCTL >>> 2] = value & ~0x33;
        break;
      case GINTSTS:
        this.intsts &= ~(value & ~GINT_DERIVED);
        break;
      case DCTL: {
        if ((value & (1 << 7)) !== 0) this.globalInNak = true;
        if ((value & (1 << 8)) !== 0) this.globalInNak = false;
        if ((value & (1 << 9)) !== 0) this.globalOutNak = true;
        if ((value & (1 << 10)) !== 0) this.globalOutNak = false;
        const before = this.regs[DCTL >>> 2];
        this.regs[DCTL >>> 2] = value & ~0x78c;
        if (((before ^ value) & 2) !== 0) this.kick(); // soft connect or disconnect
        break;
      }
      case DSTS:
      case DAINT:
      case GRXSTSR:
      case GRXSTSP:
        break;
      default:
        this.regs[offset >>> 2] = value;
    }
    this.update();
  }

  private readEp(ctl: Uint32Array, int: Uint32Array, tsiz: Uint32Array, rel: number, isIn: boolean): number {
    const n = rel >>> 5;
    switch (rel & 0x1f) {
      case 0x00:
        return ctl[n];
      case 0x08:
        return isIn ? (int[n] | (this.tx[n].empty ? EPINT.TXFE : 0)) >>> 0 : int[n];
      case 0x10:
        return tsiz[n];
      case 0x18:
        return isIn ? this.txSpace(n) : 0;
      default:
        return this.regs[((isIn ? DIEP : DOEP) + rel) >>> 2];
    }
  }

  private writeEp(rel: number, value: number, isIn: boolean): void {
    const n = rel >>> 5;
    const ctl = isIn ? this.diepctl : this.doepctl;
    const int = isIn ? this.diepint : this.doepint;
    switch (rel & 0x1f) {
      case 0x00: {
        let next = (value & ~CTL_WRITE_ONLY & ~CTL.NAKSTS) | (ctl[n] & (CTL.NAKSTS | CTL.EPENA));
        if ((value & CTL.CNAK) !== 0) next &= ~CTL.NAKSTS;
        if ((value & CTL.SNAK) !== 0) {
          next |= CTL.NAKSTS;
          if (isIn) int[n] |= EPINT.INEPNE;
        }
        if ((value & CTL.EPDIS) !== 0 && (next & CTL.EPENA) !== 0) {
          next &= ~(CTL.EPENA | CTL.EPDIS);
          int[n] |= EPINT.EPDISD;
        }
        if (n === 0) next |= 1 << 15; // USBACTEP: endpoint 0 is always active
        ctl[n] = next >>> 0;
        if ((next & CTL.EPENA) !== 0 && (next & CTL.NAKSTS) === 0) this.kick();
        break;
      }
      case 0x08:
        int[n] &= ~value;
        break;
      case 0x10:
        (isIn ? this.dieptsiz : this.doeptsiz)[n] = value;
        if (isIn) this.tx[n].target = -1;
        break;
      default:
        this.regs[((isIn ? DIEP : DOEP) + rel) >>> 2] = value;
    }
    this.update();
  }

  /** A word pushed into IN endpoint `ep`'s window: it fills the packet in progress. */
  private pushData(ep: number, value: number): void {
    this.start();
    if (ep >= EPS) return;
    const fifo = this.tx[ep];
    if (fifo.target < 0) {
      const left = this.dieptsiz[ep] & (ep === 0 ? 0x7f : 0x7ffff);
      if (left === 0) return;
      fifo.target = Math.min(this.maxPacket(ep, true), left);
      fifo.filling = 0;
    }
    for (let b = 0; b < 4 && fifo.filling < fifo.target; b++) {
      if (fifo.count < TX_BYTES) {
        fifo.bytes[(fifo.head + fifo.count) % TX_BYTES] = (value >>> (8 * b)) & 0xff;
        fifo.count++;
      }
      fifo.filling++;
    }
    if (fifo.filling >= fifo.target) {
      fifo.lengths[(fifo.first + fifo.packets) & 15] = fifo.target;
      fifo.packets++;
      const size = this.dieptsiz[ep];
      const mask = ep === 0 ? 0x7f : 0x7ffff;
      this.dieptsiz[ep] = ((size & ~mask) | ((size & mask) - fifo.target)) >>> 0;
      fifo.target = -1;
      fifo.filling = 0;
      this.kick();
    }
    this.update();
  }

  /** A word popped from the RX FIFO (the entry GRXSTSP popped last). */
  private popData(): number {
    this.start();
    if (this.readLeft <= 0) return 0;
    let v = 0;
    for (let b = 0; b < 4; b++) v |= this.rxBytes[(this.readOffset + b) % RX_BYTES] << (8 * b);
    this.readOffset = (this.readOffset + 4) % RX_BYTES;
    this.readLeft -= 4;
    return v >>> 0;
  }

  private popStatus(): number {
    if (this.rxEntries === 0) return 0;
    const status = this.rxStatus[this.rxFirst];
    this.readOffset = this.rxOffset[this.rxFirst];
    this.readLeft = (status >>> 4) & 0x7ff;
    this.rxFirst = (this.rxFirst + 1) % RX_ENTRIES;
    this.rxEntries--;
    const ep = status & 0xf;
    const pktsts = (status >>> 17) & 0xf;
    if (pktsts === PKTSTS.OUT_DONE) this.doepint[ep] |= EPINT.XFRC;
    else if (pktsts === PKTSTS.SETUP_DONE) this.doepint[ep] |= EPINT.STUP;
    this.update();
    return status;
  }

  // ── The host's side (UsbDevicePort) ───────────────────────────────────────────────────

  attached(): boolean {
    const rtcUsbConf = this.rtcUsbConf();
    const wrapConf = this.wrapConf();
    const otgPhy = (rtcUsbConf & (3 << 19)) === 3 << 19 && (wrapConf & (1 << 2)) === 0;
    const pads = (wrapConf & (1 << 18)) !== 0;
    const pullup = (wrapConf & (1 << 12)) !== 0 ? (wrapConf & (1 << 13)) !== 0 : (this.regs[DCTL >>> 2] & 2) === 0;
    return otgPhy && pads && pullup;
  }

  busReset(): void {
    for (let n = 0; n < EPS; n++) {
      this.tx[n].clear();
      this.diepctl[n] &= ~(CTL.EPENA | CTL.STALL);
      this.doepctl[n] &= ~(CTL.EPENA | CTL.STALL);
    }
    this.rxFirst = this.rxEntries = this.rxWrite = this.readLeft = 0;
    this.regs[DSTS >>> 2] &= ~0x6;
    this.intsts |= GINT.USBRST;
    this.update();
  }

  enumDone(): void {
    this.regs[DSTS >>> 2] = (this.regs[DSTS >>> 2] & ~0x6) | (3 << 1); // ENUMSPD: full speed (48 MHz PHY clock)
    this.intsts |= GINT.ENUMDNE;
    this.update();
  }

  sof(frame: number): void {
    this.frameNumber = frame;
    this.intsts |= GINT.SOF;
    this.update();
  }

  setup(packet: Uint8Array): void {
    this.diepctl[0] &= ~CTL.STALL;
    this.doepctl[0] &= ~CTL.STALL;
    this.pushRx(0, PKTSTS.SETUP_DATA, packet, 8);
    this.pushRx(0, PKTSTS.SETUP_DONE, packet, 0);
    this.update();
  }

  in(ep: number, into: Uint8Array): number {
    if (ep >= EPS) return USB_STALL;
    const ctl = this.diepctl[ep];
    if ((ctl & CTL.STALL) !== 0) return USB_STALL;
    if ((ctl & CTL.EPENA) === 0 || (ctl & CTL.NAKSTS) !== 0 || this.globalInNak) return USB_NAK;
    const fifo = this.tx[ep];
    const size = this.dieptsiz[ep];
    const pktShift = 19;
    const pktMask = ep === 0 ? 0x3 : 0x3ff;
    const pkts = (size >>> pktShift) & pktMask;
    if (pkts === 0) return USB_NAK;
    let length: number;
    if (fifo.packets > 0) {
      length = fifo.lengths[fifo.first];
      for (let i = 0; i < length; i++) into[i] = fifo.bytes[(fifo.head + i) % TX_BYTES];
      fifo.head = (fifo.head + length) % TX_BYTES;
      fifo.count -= length;
      fifo.first = (fifo.first + 1) & 15;
      fifo.packets--;
    } else if ((size & (ep === 0 ? 0x7f : 0x7ffff)) === 0 && fifo.target < 0) {
      length = 0; // a zero-length packet
    } else {
      this.diepint[ep] |= EPINT.ITTXFE;
      this.update();
      return USB_NAK;
    }
    const left = pkts - 1;
    this.dieptsiz[ep] = ((size & ~(pktMask << pktShift)) | (left << pktShift)) >>> 0;
    if (left === 0) {
      this.diepctl[ep] &= ~CTL.EPENA;
      this.diepint[ep] |= EPINT.XFRC;
    }
    this.update();
    return length;
  }

  out(ep: number, data: Uint8Array, length: number): number {
    if (ep >= EPS) return USB_STALL;
    const ctl = this.doepctl[ep];
    if ((ctl & CTL.STALL) !== 0) return USB_STALL;
    if ((ctl & CTL.EPENA) === 0 || (ctl & CTL.NAKSTS) !== 0 || this.globalOutNak) return USB_NAK;
    if (this.rxEntries + 2 > RX_ENTRIES || length > RX_BYTES / 4) return USB_NAK;
    this.pushRx(ep, PKTSTS.OUT_DATA, data, length);
    const size = this.doeptsiz[ep];
    const xferMask = ep === 0 ? 0x7f : 0x7ffff;
    const pktMask = ep === 0 ? 0x1 : 0x3ff;
    const left = Math.max(0, (size & xferMask) - length);
    const pkts = Math.max(0, ((size >>> 19) & pktMask) - 1);
    this.doeptsiz[ep] = ((size & ~xferMask & ~(pktMask << 19)) | left | (pkts << 19)) >>> 0;
    if (pkts === 0 || length < this.maxPacket(ep, false)) {
      this.pushRx(ep, PKTSTS.OUT_DONE, data, 0);
      this.doepctl[ep] = ((this.doepctl[ep] & ~CTL.EPENA) | CTL.NAKSTS) >>> 0;
    }
    this.update();
    return USB_ACK;
  }

  /** Bytes for the device's CDC-ACM port (the serial monitor typing). */
  send(bytes: Uint8Array): void {
    this.host.send(bytes);
    this.kick();
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────

  private pushRx(ep: number, pktsts: number, data: Uint8Array, length: number): void {
    const at = this.rxWrite;
    for (let i = 0; i < length; i++) this.rxBytes[(at + i) % RX_BYTES] = data[i];
    this.rxWrite = (at + ((length + 3) & ~3)) % RX_BYTES;
    const slot = (this.rxFirst + this.rxEntries) % RX_ENTRIES;
    this.rxStatus[slot] = (ep | (length << 4) | (pktsts << 17)) >>> 0;
    this.rxOffset[slot] = at;
    this.rxEntries++;
  }

  /** Endpoint `ep`'s max packet size (endpoint 0: DIEPCTL0's 2-bit code). */
  private maxPacket(ep: number, isIn: boolean): number {
    if (ep === 0) return [64, 32, 16, 8][this.diepctl[0] & 3];
    return (isIn ? this.diepctl : this.doepctl)[ep] & 0x7ff || 64;
  }

  private txFifoOf(ep: number): number {
    return ep === 0 ? 0 : (this.diepctl[ep] >>> 22) & 0xf;
  }

  /** DTXFSTS: free words in IN endpoint `ep`'s FIFO (its depth from GNPTXFSIZ or DIEPTXFn). */
  private txSpace(ep: number): number {
    const fifo = this.txFifoOf(ep);
    const depth = fifo === 0 ? this.regs[GNPTXFSIZ >>> 2] >>> 16 : this.regs[(DIEPTXF1 + (fifo - 1) * 4) >>> 2] >>> 16;
    const used = (this.tx[ep].count + 3) >>> 2;
    return Math.max(0, (depth || 16) - used);
  }

  private daint(): number {
    let v = 0;
    const inMask = this.regs[DIEPMSK >>> 2];
    const outMask = this.regs[DOEPMSK >>> 2];
    const empty = this.regs[DIEPEMPMSK >>> 2];
    for (let n = 0; n < EPS; n++) {
      if ((this.diepint[n] & inMask) !== 0 || (this.tx[n].empty && (empty & (1 << n)) !== 0)) v |= 1 << n;
      if ((this.doepint[n] & outMask) !== 0) v |= 1 << (16 + n);
    }
    return v >>> 0;
  }

  private gintsts(): number {
    let v = this.intsts;
    if (this.rxEntries > 0) v |= GINT.RXFLVL;
    const pending = this.daint() & this.regs[DAINTMSK >>> 2];
    if ((pending & 0xffff) !== 0) v |= GINT.IEPINT;
    if ((pending >>> 16) !== 0) v |= GINT.OEPINT;
    if (this.regs[GOTGINT >>> 2] !== 0) v |= GINT.OTGINT;
    if (this.globalInNak) v |= GINT.GINNAKEFF;
    if (this.globalOutNak) v |= GINT.GOUTNAKEFF;
    return v >>> 0;
  }

  private update(): void {
    const on = (this.regs[GAHBCFG >>> 2] & 1) !== 0 && (this.gintsts() & this.regs[GINTMSK >>> 2]) !== 0;
    this.ctx.matrix.setSource(this.source, on);
  }

  /** Frames begin at the firmware's first access to USB0. */
  private start(): void {
    if (this.frames) return;
    this.frames = true;
    this.ctx.events.schedule(this.frameSlot, this.ctx.now() + this.framePeriod);
  }

  private frame(): void {
    this.host.frame();
    this.ctx.events.schedule(this.frameSlot, this.ctx.events.firing + this.framePeriod);
  }

  /** Something the host waits on changed: its next service comes HOST_LATENCY from now. */
  private kick(): void {
    if (!this.frames) return;
    const when = this.ctx.now() + this.hostLatency;
    if (this.hostAt >= 0 && this.hostAt <= when) return;
    this.hostAt = when;
    this.ctx.events.schedule(this.hostSlot, when);
    this.ctx.hurry(when);
  }
}
