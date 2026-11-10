/**
 * BT196: NXP's MFRC522 contactless reader IC (datasheet MFRC522 rev 3.9), the chip on the RC522
 * module — its SPI interface, registers, FIFO, commands, timer and interrupts, and a radio that
 * hands ISO/IEC 14443 type A frames to a `Picc` (picc.ts) on the antenna.
 *
 * SPI (8.1.2): an address byte (bit 7 1 = read, bits 6–1 the register) starts a frame. Reading,
 * each further byte is the next address to read (00h ends) and returns the previous address's
 * data, so FIFODataReg can be read out by repeating its address; writing, every byte after the
 * address is data for that same register. A frame ends when NSS rises.
 *
 * Registers (9.2, Table 20) at their reset values; VersionReg reads 92h (version 2.0). FIFO
 * (8.3): 64 bytes; FIFOLevelReg's level and FlushBuffer, WaterLevelReg's HiAlert/LoAlert
 * (Status1Reg, and their latched IRq bits), BufferOvfl when full. Interrupts (8.4): ComIrqReg and
 * DivIrqReg set or cleared through Set1/Set2, Status1Reg's IRq from the enables, the IRQ pin's
 * output from IRqInv (ComIEnReg) and IRQPushPull (DivIEnReg) — open-drain and active low out of
 * reset. Timer (8.5): f = 13.56 MHz / (2·TPrescaler + 1) (+ 2 with TPrescalEven), TimerIRq after
 * (TReload + 1) ticks, TAutoRestart, TStartNow/TStopNow, TAuto (starts at the end of every
 * transmission and, without RxMultiple, stops at an answer's fifth bit), TCounterVal readable.
 *
 * Commands (10.3): Idle; Mem (25 bytes between the FIFO and the internal buffer); Generate
 * RandomID (10 bytes into that buffer, from a deterministic generator); CalcCRC (CRC_A of the FIFO
 * and every byte written to it while running, preset from ModeReg; CRCResultReg, CRCReady/CRCOk,
 * CRCIRq; runs until another command); Transmit; Receive; Transceive (each transmission started
 * by StartSend, TxLastBits for the last byte's bits, RxAlign for the first answer bit's position,
 * RxLastBits after; TxCRCEn appends CRC_A, RxCRCEn checks and removes it — CRCErr); MFAuthent
 * (12 FIFO bytes: 60h/61h, block, key, UID; MFCrypto1On on success, the card's silence left to the
 * timer, a non-answer ProtocolErr); SoftReset (registers to reset values, the internal buffer
 * kept); an unknown command goes idle with IdleIRq. CommandReg's RcvOff (no reception) and
 * PowerDown (soft power-down: the antenna off) are kept; wake-up is immediate.
 *
 * Over the air: 106 kbit/s, a frame taking 1 + 9 bits per byte + the last byte's bits + 1 elementary
 * time units (128/fc), a card answering 100 µs after the reader's frame (ISO 14443's 86–91 µs
 * frame delay, rounded up) plus its own delay. The antenna radiates while TxControlReg's
 * Tx1RFEn/Tx2RFEn are set (and the chip isn't powered down). One card at a time: no collisions,
 * no parity or framing errors. Not modelled: MSBFirst CRCs, the self test, the analog test
 * registers, speeds above 106 kbit/s (TxSpeed/RxSpeed are stored).
 */

import { crcAUpdate, type Picc, type PiccAnswer } from './picc.ts';

/** What the chip needs from its board: time, timers, and a nudge when the IRQ output or the field changed. */
export interface Mfrc522Host {
  now(): number;
  schedule(delayNs: number, callback: () => void): number;
  cancel(id: number): void;
  changed(): void;
}

export const MFRC522_VERSION = 0x92;

/** Register addresses (Table 20). */
export const MFRC522_REG = {
  Command: 0x01,
  ComIEn: 0x02,
  DivIEn: 0x03,
  ComIrq: 0x04,
  DivIrq: 0x05,
  Error: 0x06,
  Status1: 0x07,
  Status2: 0x08,
  FifoData: 0x09,
  FifoLevel: 0x0a,
  WaterLevel: 0x0b,
  Control: 0x0c,
  BitFraming: 0x0d,
  Coll: 0x0e,
  Mode: 0x11,
  TxMode: 0x12,
  RxMode: 0x13,
  TxControl: 0x14,
  TxAsk: 0x15,
  CrcResultH: 0x21,
  CrcResultL: 0x22,
  ModWidth: 0x24,
  Demod: 0x19,
  TMode: 0x2a,
  TPrescaler: 0x2b,
  TReloadH: 0x2c,
  TReloadL: 0x2d,
  TCounterH: 0x2e,
  TCounterL: 0x2f,
  AutoTest: 0x36,
  Version: 0x37,
} as const;

/** CommandReg's command codes (Table 149). */
export const MFRC522_CMD = {
  Idle: 0x0,
  Mem: 0x1,
  GenerateRandomId: 0x2,
  CalcCrc: 0x3,
  Transmit: 0x4,
  NoCmdChange: 0x7,
  Receive: 0x8,
  Transceive: 0xc,
  MfAuthent: 0xe,
  SoftReset: 0xf,
} as const;

/** The registers that don't reset to 0 (Table 20's reset values). */
const RESET_VALUES: readonly (readonly [number, number])[] = [
  [0x01, 0x20],
  [0x02, 0x80],
  [0x04, 0x14],
  [0x0b, 0x08],
  [0x0c, 0x10],
  [0x0e, 0xa0],
  [0x11, 0x3f],
  [0x14, 0x80],
  [0x16, 0x10],
  [0x17, 0x84],
  [0x18, 0x84],
  [0x19, 0x4d],
  [0x1c, 0x62],
  [0x1f, 0xeb],
  [0x21, 0xff],
  [0x22, 0xff],
  [0x24, 0x26],
  [0x26, 0x48],
  [0x27, 0x88],
  [0x28, 0x20],
  [0x29, 0x20],
  [0x33, 0x80],
  [0x36, 0x40],
  [0x37, MFRC522_VERSION],
];

/** ComIrqReg bits. */
const TX_IRQ = 0x40;
const RX_IRQ = 0x20;
const IDLE_IRQ = 0x10;
const HI_ALERT_IRQ = 0x08;
const LO_ALERT_IRQ = 0x04;
const ERR_IRQ = 0x02;
const TIMER_IRQ = 0x01;
/** DivIrqReg's CRCIRq. */
const CRC_IRQ = 0x04;
/** ErrorReg bits. */
const WR_ERR = 0x80;
const BUFFER_OVFL = 0x10;
const CRC_ERR = 0x04;
const PROTOCOL_ERR = 0x01;
/** The receiver's errors, cleared as it starts: CollErr, CRCErr, ParityErr, ProtocolErr. */
const RX_ERRORS = 0x0f;

/** One elementary time unit at 106 kbit/s: 128 / 13.56 MHz, ns. */
export const RFID_ETU_NS = (128 * 1e9) / 13.56e6;
/** The card's frame delay after the reader's last bit (ISO 14443-3's 86–91 µs, rounded up), ns. */
export const RFID_FDT_NS = 100_000;

/** How long a frame of `length` bytes takes on air, its last byte's `lastBits` sent (8 = all), ns. */
export function rfidFrameNs(length: number, lastBits: number): number {
  if (length === 0) return 2 * RFID_ETU_NS;
  const full = lastBits >= 8 ? length : length - 1;
  return (2 + 9 * full + (lastBits >= 8 ? 0 : lastBits)) * RFID_ETU_NS;
}

/** The modem's states (Status2Reg ModemState). */
const MODEM_IDLE = 0;
const MODEM_WAIT_SEND = 1;
const MODEM_TRANSMITTING = 3;
const MODEM_WAIT_DATA = 5;
const MODEM_RECEIVING = 6;

/** The radio's next event. */
const RADIO_NONE = 0;
const RADIO_TX_END = 1;
const RADIO_RX_START = 2;
const RADIO_RX_END = 3;
const RADIO_AUTH_TX_END = 4;
const RADIO_AUTH_DONE = 5;

/** MFAuthent's exchange after its first frame: the card's nonce, the reader's 8 bytes, the card's answer. */
const AUTH_REST_NS = 2 * RFID_FDT_NS + rfidFrameNs(4, 8) + rfidFrameNs(8, 8) + rfidFrameNs(4, 8);

export class Mfrc522 {
  readonly regs = new Uint8Array(64);
  /** The card on the antenna, if any (set through `setPicc`). */
  private picc: Picc | null = null;
  private readonly fifo = new Uint8Array(64);
  private fifoHead = 0;
  private fifoCount = 0;
  private readonly internal = new Uint8Array(25);
  private command: number = MFRC522_CMD.Idle;
  private crc = 0;
  private crcReady = true;
  private crcOk = false;
  private crypto = false;
  private modem = MODEM_IDLE;
  private rxLastBits = 0;
  private enabled = false;
  private fieldOn = false;
  private random: number;
  // SPI frame: 0 waiting for an address, 1 reading, 2 writing, 3 done.
  private spiState = 0;
  private spiAddress = 0;
  // The radio.
  private readonly tx = new Uint8Array(68);
  private txLength = 0;
  private txLast = 8;
  private readonly rx = new Uint8Array(80);
  private rxLength = 0;
  private rxLast = 8;
  private readonly auth = new Uint8Array(12);
  private radio = RADIO_NONE;
  private radioTimer = -1;
  // The timer unit.
  private timerId = -1;
  private timerRunning = false;
  private timerFrom = 0;
  private timerTick = 1;
  private timerReload = 0;
  private timerHeld = 0;

  private readonly host: Mfrc522Host;
  private answerDelay = 0;

  constructor(host: Mfrc522Host, seed = 0x2545f491) {
    this.host = host;
    this.random = seed >>> 0 || 1;
    this.resetRegisters();
  }

  /** Power and NRSTPD together: off is hard power-down; on is a hard reset. */
  power(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.stopRadio();
    this.stopTimer();
    this.timerHeld = 0;
    this.internal.fill(0);
    this.resetRegisters();
    this.updateField();
    this.host.changed();
  }

  get powered(): boolean {
    return this.enabled;
  }

  /** The RF field is on (the antenna drivers enabled, the chip running). */
  get field(): boolean {
    return this.fieldOn;
  }

  /** MFCrypto1On: a MIFARE authentication holds. */
  get cryptoOn(): boolean {
    return this.crypto;
  }

  /** Put a card on the antenna (or take it away with null). */
  setPicc(picc: Picc | null): void {
    if (picc === this.picc) return;
    if (this.picc !== null && this.fieldOn) this.picc.field(false);
    this.picc = picc;
    if (picc !== null && this.fieldOn) picc.field(true);
  }

  /** Status1Reg's IRq: an enabled interrupt is pending. */
  get irq(): boolean {
    const r = this.regs;
    return (r[0x02] & r[0x04] & 0x7f) !== 0 || (r[0x03] & r[0x05] & 0x14) !== 0;
  }

  /** The IRQ pin: 1 or 0 driven, −1 released (open-drain high, or unpowered). */
  irqOutput(): number {
    if (!this.enabled) return -1;
    const high = (this.regs[0x02] & 0x80) !== 0 ? !this.irq : this.irq;
    if ((this.regs[0x03] & 0x80) !== 0) return high ? 1 : 0;
    return high ? -1 : 0;
  }

  /** NSS changed: a new SPI frame starts at the next byte. */
  select(): void {
    this.spiState = 0;
  }

  /** One SPI byte while NSS is low (MOSI in, MISO out). */
  transfer(mosi: number): number {
    if (!this.enabled) return 0xff;
    switch (this.spiState) {
      case 0:
        this.spiAddress = (mosi >> 1) & 0x3f;
        this.spiState = (mosi & 0x80) !== 0 ? 1 : 2;
        return 0;
      case 1: {
        const value = this.read(this.spiAddress);
        if ((mosi & 0x80) !== 0) this.spiAddress = (mosi >> 1) & 0x3f;
        else this.spiState = 3;
        return value;
      }
      case 2:
        this.write(this.spiAddress, mosi);
        return 0;
      default:
        return 0;
    }
  }

  /** A register read, with its side effects (FIFODataReg pops). */
  read(address: number): number {
    const r = this.regs;
    switch (address) {
      case 0x01:
        return (r[0x01] & 0x30) | this.command;
      case 0x04:
        return r[0x04] & 0x7f;
      case 0x05:
        return r[0x05] & 0x14;
      case 0x07:
        return this.status1();
      case 0x08:
        return (r[0x08] & 0xc0) | (this.crypto ? 0x08 : 0) | this.modem;
      case 0x09:
        return this.pop();
      case 0x0a:
        return this.fifoCount;
      case 0x0c:
        return 0x10 | this.rxLastBits;
      case 0x0e:
        return (r[0x0e] & 0x80) | 0x20;
      case 0x2e:
        return this.counter() >> 8;
      case 0x2f:
        return this.counter() & 0xff;
      case 0x37:
        return MFRC522_VERSION;
      default:
        return r[address & 0x3f];
    }
  }

  /** A register write, with its side effects. */
  write(address: number, value: number): void {
    const r = this.regs;
    const v = value & 0xff;
    switch (address) {
      case 0x01:
        this.writeCommand(v);
        return;
      case 0x02:
        r[0x02] = v;
        break;
      case 0x03:
        r[0x03] = v & 0x94;
        break;
      case 0x04:
        if ((v & 0x80) !== 0) r[0x04] |= v & 0x7f;
        else r[0x04] &= ~v & 0x7f;
        break;
      case 0x05:
        if ((v & 0x80) !== 0) r[0x05] |= v & 0x14;
        else r[0x05] &= ~v & 0x14;
        break;
      case 0x06:
      case 0x07:
      case 0x21:
      case 0x22:
      case 0x2e:
      case 0x2f:
      case 0x37:
        return; // read-only
      case 0x08:
        r[0x08] = v & 0xc0;
        if ((v & 0x08) === 0) this.crypto = false;
        return;
      case 0x09:
        this.push(v);
        return;
      case 0x0a:
        if ((v & 0x80) !== 0) {
          this.fifoHead = 0;
          this.fifoCount = 0;
          r[0x06] &= ~BUFFER_OVFL;
          this.fifoChanged();
        }
        return;
      case 0x0b:
        r[0x0b] = v & 0x3f;
        this.fifoChanged();
        return;
      case 0x0c:
        if ((v & 0x80) !== 0) this.stopTimer();
        if ((v & 0x40) !== 0) this.startTimer();
        return;
      case 0x0d:
        r[0x0d] = v & 0x77;
        if ((v & 0x80) !== 0 && this.command === MFRC522_CMD.Transceive && this.radio === RADIO_NONE) this.transmit();
        return;
      case 0x0e:
        r[0x0e] = v & 0x80;
        return;
      case 0x14:
        r[0x14] = v;
        this.updateField();
        return;
      default:
        r[address & 0x3f] = v;
        return;
    }
    this.host.changed();
  }

  private resetRegisters(): void {
    this.regs.fill(0);
    for (const [address, value] of RESET_VALUES) this.regs[address] = value;
    this.fifoHead = 0;
    this.fifoCount = 0;
    this.command = MFRC522_CMD.Idle;
    this.crcReady = true;
    this.crcOk = false;
    this.crypto = false;
    this.modem = MODEM_IDLE;
    this.rxLastBits = 0;
    this.spiState = 0;
  }

  private status1(): number {
    const level = this.regs[0x0b] & 0x3f;
    return (
      (this.crcOk ? 0x40 : 0) |
      (this.crcReady ? 0x20 : 0) |
      (this.irq ? 0x10 : 0) |
      (this.timerRunning ? 0x08 : 0) |
      (64 - this.fifoCount <= level ? 0x02 : 0) |
      (this.fifoCount <= level ? 0x01 : 0)
    );
  }

  private setIrq(bits: number): void {
    this.regs[0x04] |= bits;
    this.host.changed();
  }

  private setError(bits: number): void {
    this.regs[0x06] |= bits;
    this.setIrq(ERR_IRQ);
  }

  // The FIFO.

  private push(v: number): void {
    if (this.command === MFRC522_CMD.MfAuthent) this.setError(WR_ERR);
    if (this.fifoCount === 64) {
      this.setError(BUFFER_OVFL);
      return;
    }
    this.fifo[(this.fifoHead + this.fifoCount) & 63] = v;
    this.fifoCount++;
    if (this.command === MFRC522_CMD.CalcCrc) this.calculateCrc();
    else this.fifoChanged();
  }

  private pop(): number {
    if (this.fifoCount === 0) return 0;
    const v = this.fifo[this.fifoHead];
    this.fifoHead = (this.fifoHead + 1) & 63;
    this.fifoCount--;
    this.fifoChanged();
    return v;
  }

  /** The level changed: latch the alerts that now hold. */
  private fifoChanged(): void {
    const level = this.regs[0x0b] & 0x3f;
    let bits = 0;
    if (64 - this.fifoCount <= level) bits |= HI_ALERT_IRQ;
    if (this.fifoCount <= level) bits |= LO_ALERT_IRQ;
    this.regs[0x04] |= bits;
    this.host.changed();
  }

  // Commands.

  private writeCommand(v: number): void {
    const r = this.regs;
    const wasDown = (r[0x01] & 0x10) !== 0;
    r[0x01] = (r[0x01] & 0x0f) | (v & 0x30);
    const down = (v & 0x10) !== 0;
    const command = v & 0x0f;
    if (down !== wasDown) {
      if (down) {
        this.stopRadio();
        this.command = MFRC522_CMD.Idle;
      }
      this.updateField();
    }
    if (command === MFRC522_CMD.NoCmdChange || down) {
      this.host.changed();
      return;
    }
    this.startCommand(command);
  }

  private startCommand(command: number): void {
    this.stopRadio();
    this.command = MFRC522_CMD.Idle;
    switch (command) {
      case MFRC522_CMD.Idle:
        break;
      case MFRC522_CMD.Mem:
        if (this.fifoCount === 0) {
          for (let i = 0; i < 25; i++) this.fifo[i] = this.internal[i];
          this.fifoHead = 0;
          this.fifoCount = 25;
        } else {
          const n = Math.min(25, this.fifoCount);
          for (let i = 0; i < n; i++) this.internal[i] = this.fifo[(this.fifoHead + i) & 63];
          this.fifoHead = (this.fifoHead + n) & 63;
          this.fifoCount -= n;
        }
        this.fifoChanged();
        this.finish();
        break;
      case MFRC522_CMD.GenerateRandomId:
        for (let i = 0; i < 10; i++) this.internal[i] = this.nextRandom() & 0xff;
        this.finish();
        break;
      case MFRC522_CMD.CalcCrc: {
        this.command = MFRC522_CMD.CalcCrc;
        const preset = this.regs[0x11] & 3;
        this.crc = preset === 0 ? 0x0000 : preset === 1 ? 0x6363 : preset === 2 ? 0xa671 : 0xffff;
        this.crcReady = false;
        this.crcOk = false;
        this.calculateCrc();
        break;
      }
      case MFRC522_CMD.Transmit:
        this.command = MFRC522_CMD.Transmit;
        this.transmit();
        break;
      case MFRC522_CMD.Receive:
        this.command = MFRC522_CMD.Receive;
        this.regs[0x06] &= ~RX_ERRORS;
        this.modem = MODEM_WAIT_DATA; // nothing sends unasked: waits for another command or the timer
        break;
      case MFRC522_CMD.Transceive:
        this.command = MFRC522_CMD.Transceive;
        this.modem = MODEM_WAIT_SEND;
        break;
      case MFRC522_CMD.MfAuthent:
        this.command = MFRC522_CMD.MfAuthent;
        this.authenticate();
        break;
      case MFRC522_CMD.SoftReset: {
        this.stopTimer();
        this.timerHeld = 0;
        this.resetRegisters();
        this.updateField();
        break;
      }
      default:
        this.finish(); // an unknown command goes idle
    }
    this.host.changed();
  }

  /** A command ended by itself: back to Idle with IdleIRq. */
  private finish(): void {
    this.command = MFRC522_CMD.Idle;
    this.modem = MODEM_IDLE;
    this.setIrq(IDLE_IRQ);
  }

  /** CalcCRC: the FIFO's bytes into the coprocessor. */
  private calculateCrc(): void {
    while (this.fifoCount > 0) {
      this.crc = crcAUpdate(this.crc, this.fifo[this.fifoHead]);
      this.fifoHead = (this.fifoHead + 1) & 63;
      this.fifoCount--;
    }
    this.regs[0x21] = this.crc >> 8;
    this.regs[0x22] = this.crc & 0xff;
    this.crcReady = true;
    this.crcOk = this.crc === 0;
    this.regs[0x05] |= CRC_IRQ;
    this.fifoChanged();
  }

  private nextRandom(): number {
    let x = this.random;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.random = x >>> 0;
    return this.random;
  }

  // The radio.

  private updateField(): void {
    const on = this.enabled && (this.regs[0x01] & 0x10) === 0 && (this.regs[0x14] & 3) !== 0;
    if (on === this.fieldOn) return;
    this.fieldOn = on;
    this.picc?.field(on);
    this.host.changed();
  }

  private stopRadio(): void {
    if (this.radioTimer >= 0) this.host.cancel(this.radioTimer);
    this.radioTimer = -1;
    this.radio = RADIO_NONE;
    this.modem = MODEM_IDLE;
  }

  private radioAfter(ns: number, next: number): void {
    this.radio = next;
    this.radioTimer = this.host.schedule(Math.max(1, Math.round(ns)), this.onRadio);
  }

  /** Transmit or Transceive: the FIFO goes on air. */
  private transmit(): void {
    const n = this.fifoCount;
    for (let i = 0; i < n; i++) this.tx[i] = this.fifo[(this.fifoHead + i) & 63];
    this.fifoHead = 0;
    this.fifoCount = 0;
    this.fifoChanged();
    this.txLength = n;
    const last = this.regs[0x0d] & 7;
    this.txLast = last === 0 || n === 0 ? 8 : last;
    if (this.txLast < 8) this.tx[n - 1] &= (1 << this.txLast) - 1;
    else if ((this.regs[0x12] & 0x80) !== 0 && n > 0) {
      const crc = this.frameCrc(this.tx, n);
      this.tx[n] = crc & 0xff;
      this.tx[n + 1] = crc >> 8;
      this.txLength = n + 2;
    }
    this.modem = MODEM_TRANSMITTING;
    this.radioAfter(rfidFrameNs(this.txLength, this.txLast), RADIO_TX_END);
  }

  private frameCrc(data: Uint8Array, length: number): number {
    const preset = this.regs[0x11] & 3;
    let crc = preset === 0 ? 0x0000 : preset === 1 ? 0x6363 : preset === 2 ? 0xa671 : 0xffff;
    for (let i = 0; i < length; i++) crc = crcAUpdate(crc, data[i]);
    return crc;
  }

  /** MFAuthent: 12 bytes from the FIFO, the first frame on air. */
  private authenticate(): void {
    const n = Math.min(12, this.fifoCount);
    this.auth.fill(0);
    for (let i = 0; i < n; i++) this.auth[i] = this.fifo[(this.fifoHead + i) & 63];
    this.fifoHead = 0;
    this.fifoCount = 0;
    this.fifoChanged();
    this.txLength = n < 12 ? 0 : 12;
    this.regs[0x06] &= ~PROTOCOL_ERR;
    this.crypto = false;
    this.modem = MODEM_TRANSMITTING;
    this.radioAfter(rfidFrameNs(4, 8), RADIO_AUTH_TX_END);
  }

  private answered(answer: PiccAnswer): void {
    const n = Math.min(answer.length, this.rx.length);
    for (let i = 0; i < n; i++) this.rx[i] = answer.bytes[i];
    this.rxLength = n;
    this.rxLast = answer.lastBits >= 8 || answer.lastBits <= 0 ? 8 : answer.lastBits;
    if (this.rxLast < 8 && n > 0) this.rx[n - 1] &= (1 << this.rxLast) - 1;
  }

  private readonly onRadio = (): void => {
    this.radioTimer = -1;
    const step = this.radio;
    this.radio = RADIO_NONE;
    const tAuto = (this.regs[0x2a] & 0x80) !== 0;
    switch (step) {
      case RADIO_TX_END: {
        this.setIrq(TX_IRQ);
        if (tAuto) this.startTimer();
        if (this.command === MFRC522_CMD.Transmit) {
          this.deliver(false);
          this.finish();
          return;
        }
        this.regs[0x06] &= ~RX_ERRORS;
        this.modem = MODEM_WAIT_DATA;
        if (this.deliver(true)) this.radioAfter(RFID_FDT_NS + this.answerDelay + 5 * RFID_ETU_NS, RADIO_RX_START);
        return;
      }
      case RADIO_RX_START:
        if (tAuto && (this.regs[0x13] & 0x04) === 0) this.stopTimer();
        this.modem = MODEM_RECEIVING;
        this.radioAfter(rfidFrameNs(this.rxLength, this.rxLast) - 5 * RFID_ETU_NS, RADIO_RX_END);
        return;
      case RADIO_RX_END:
        this.receive();
        return;
      case RADIO_AUTH_TX_END: {
        if (tAuto) this.startTimer();
        this.modem = MODEM_WAIT_DATA;
        const card = this.picc;
        if (card === null || !this.fieldOn || (this.regs[0x01] & 0x20) !== 0 || this.txLength === 0) return;
        const a = this.auth;
        const outcome = card.authenticate(a[0], a[1], a, 2, a, 8);
        if (outcome === 'ok') this.radioAfter(AUTH_REST_NS, RADIO_AUTH_DONE);
        else if (outcome === 'protocol') {
          if (tAuto) this.stopTimer();
          this.setError(PROTOCOL_ERR);
          this.finish();
        }
        return;
      }
      case RADIO_AUTH_DONE:
        if (tAuto) this.stopTimer();
        this.crypto = true;
        this.finish();
        return;
    }
  };

  /** The frame in `tx` reaches the card; true when it answers (into `rx`). */
  private deliver(listen: boolean): boolean {
    const card = this.picc;
    if (card === null || !this.fieldOn) return false;
    const answer = card.frame(this.tx, this.txLength, this.txLast, this.crypto);
    if (answer === null || !listen || (this.regs[0x01] & 0x20) !== 0) return false;
    this.answered(answer);
    this.answerDelay = Math.max(0, answer.delayNs);
    return this.rxLength > 0;
  }

  /** The answer's last bit: into the FIFO at RxAlign, RxLastBits, the CRC check, RxIRq. */
  private receive(): void {
    let length = this.rxLength;
    let last = this.rxLast;
    if ((this.regs[0x13] & 0x80) !== 0) {
      if (last === 8 && length >= 3 && this.frameCrc(this.rx, length) === 0) length -= 2;
      else this.setError(CRC_ERR);
    }
    const align = (this.regs[0x0d] >> 4) & 7;
    let bits = (length - 1) * 8 + last + align;
    if (length === 0) bits = 0;
    const bytes = (bits + 7) >> 3;
    for (let m = 0; m < bytes; m++) {
      const low = m < length ? (this.rx[m] << align) & 0xff : 0;
      const carry = align > 0 && m > 0 ? this.rx[m - 1] >> (8 - align) : 0;
      this.pushReceived(low | carry);
    }
    last = bits & 7;
    this.rxLastBits = last;
    this.fifoChanged();
    this.setIrq(RX_IRQ);
    if (this.command === MFRC522_CMD.Receive) this.finish();
    else this.modem = MODEM_WAIT_SEND;
  }

  private pushReceived(v: number): void {
    if (this.fifoCount === 64) {
      this.setError(BUFFER_OVFL);
      return;
    }
    this.fifo[(this.fifoHead + this.fifoCount) & 63] = v;
    this.fifoCount++;
  }

  // The timer unit.

  private startTimer(): void {
    if (this.timerId >= 0) this.host.cancel(this.timerId);
    const r = this.regs;
    const prescaler = ((r[0x2a] & 0x0f) << 8) | r[0x2b];
    this.timerTick = ((2 * prescaler + ((r[0x19] & 0x10) !== 0 ? 2 : 1)) * 1e9) / 13.56e6;
    this.timerReload = (r[0x2c] << 8) | r[0x2d];
    this.timerFrom = this.host.now();
    this.timerRunning = true;
    this.timerId = this.host.schedule(Math.max(1, Math.round((this.timerReload + 1) * this.timerTick)), this.onTimer);
  }

  private stopTimer(): void {
    if (!this.timerRunning) return;
    this.timerHeld = this.counter();
    this.timerRunning = false;
    if (this.timerId >= 0) this.host.cancel(this.timerId);
    this.timerId = -1;
  }

  private counter(): number {
    if (!this.timerRunning) return this.timerHeld;
    const ticks = Math.floor((this.host.now() - this.timerFrom) / this.timerTick);
    return Math.max(0, this.timerReload - ticks);
  }

  private readonly onTimer = (): void => {
    this.timerId = -1;
    this.timerRunning = false;
    this.timerHeld = 0;
    this.setIrq(TIMER_IRQ);
    if ((this.regs[0x2a] & 0x10) !== 0) this.startTimer();
  };
}
