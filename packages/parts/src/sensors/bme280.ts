/**
 * BT191: the Bosch BME280 (temperature, pressure, humidity) and BMP280 (no humidity) on the purple
 * 6-pin breakout (`bme280`, `bmp280`: VCC, GND, SCL, SDA, CSB, SDO), from Bosch's BME280 datasheet
 * (BST-BME280-DS001-23 rev 1.23; the BMP280 is the same register map without humidity, its Table 17).
 *
 * Registers (Table 18): calibration at 0x88–0xA1 and 0xE1–0xE7 (Table 16), id 0xD0 (0x60, BMP280
 * 0x58), reset 0xE0 (0xB6 resets; reads 0), ctrl_hum 0xF2 (osrs_h, effective at the next ctrl_meas
 * write), status 0xF3 (measuring, bit 3), ctrl_meas 0xF4 (osrs_t, osrs_p, mode), config 0xF5 (t_sb,
 * filter), data 0xF7–0xFE (press and temp 20-bit, hum 16-bit; 0x80000/0x8000 until measured or while
 * a channel is skipped). Modes: sleep (00), forced (01, 10: one measurement, then sleep), normal
 * (11: measurement, standby t_sb, again — Table 27: 0.5, 62.5, 125, 250, 500, 1000, then 10 and 20 ms;
 * the BMP280 2000 and 4000 ms). A measurement takes the datasheet's maximum, 1.25 + 2.3·T +
 * (2.3·P + 0.575) + (2.3·H + 0.575) ms (Appendix B, skipped channels left out), with `measuring` set
 * meanwhile. Oversampling ×1…×16 gives 16…20-bit words (the low bits zero); the IIR filter (config
 * coefficient 2–16) filters the pressure and temperature words, which are then 20-bit (Table 17).
 *
 * Calibration: fixed trimming words — the BMP280 datasheet's worked example for temperature and
 * pressure (dig_T1 27504 …; its adc_T 519888 reads 25.08 °C), typical values for humidity. The raw
 * words are found by inverting the datasheet's integer compensation (4.2.3: int32 temperature and
 * humidity, int64 pressure — BigInt here) for the values the part should show, by binary search,
 * only when those values change; any library's compensation reads them back within the resolution.
 *
 * Interfaces (6.1–6.3): I2C at 0x76 (SDO low — the board pulls it down) or 0x77 (SDO high); writes
 * are register/data pairs, reads auto-increment from the last register written. CSB low selects
 * 4-wire SPI (mode 0 or 3, transaction-level here): a control byte (bit 7 1 = read, else write, the
 * register address's own bit 7 implied), reads auto-increment, writes are control/data pairs; once
 * CSB has gone low, I2C is off until power-off (the board pulls CSB up). Powered means VCC at 1.71 V
 * or more over GND.
 *
 * Inputs: channels `temperature` (°C, −40…85), `humidity` (%, 0…100; BME280 only) and `pressure`
 * (hPa, 300…1100), or the environment's temperature and humidity at the part; props hold the
 * initial values. Visual: those values and `measuring`.
 */

import { type I2cDevice, type NetState, type PartContext, type PartInput, type PartProps, type SpiDevice, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { readChannelInput } from '../shared/channel-input.ts';

/** The trimming words every simulated chip carries (Table 16's order). */
export const BME280_CALIBRATION = {
  T1: 27504,
  T2: 26435,
  T3: -1000,
  P1: 36477,
  P2: -10685,
  P3: 3024,
  P4: 2855,
  P5: 140,
  P6: -7,
  P7: 15500,
  P8: -14600,
  P9: 6000,
  H1: 75,
  H2: 362,
  H3: 0,
  H4: 313,
  H5: 50,
  H6: 30,
} as const;
const C = BME280_CALIBRATION;

/** 4.2.3: temperature in 0.01 °C and t_fine for a raw word. */
export function compensateT(adcT: number): { t: number; tFine: number } {
  const var1 = Math.imul((adcT >> 3) - (C.T1 << 1), C.T2) >> 11;
  const d = (adcT >> 4) - C.T1;
  const var2 = Math.imul(Math.imul(d, d) >> 12, C.T3) >> 14;
  const tFine = (var1 + var2) | 0;
  return { t: (Math.imul(tFine, 5) + 128) >> 8, tFine };
}

const P1 = BigInt(C.P1);
const P2 = BigInt(C.P2);
const P3 = BigInt(C.P3);
const P4 = BigInt(C.P4);
const P5 = BigInt(C.P5);
const P6 = BigInt(C.P6);
const P7 = BigInt(C.P7);
const P8 = BigInt(C.P8);
const P9 = BigInt(C.P9);

/** 4.2.3: pressure in Pa × 256 (Q24.8) for a raw word, with t_fine; 0 where the formula divides by 0. */
export function compensateP(adcP: number, tFine: number): number {
  let var1 = BigInt(tFine) - 128000n;
  let var2 = var1 * var1 * P6;
  var2 = var2 + ((var1 * P5) << 17n);
  var2 = var2 + (P4 << 35n);
  var1 = ((var1 * var1 * P3) >> 8n) + ((var1 * P2) << 12n);
  var1 = (((1n << 47n) + var1) * P1) >> 33n;
  if (var1 === 0n) return 0;
  let p = 1048576n - BigInt(adcP);
  p = (((p << 31n) - var2) * 3125n) / var1;
  var1 = (P9 * (p >> 13n) * (p >> 13n)) >> 25n;
  var2 = (P8 * p) >> 19n;
  p = ((p + var1 + var2) >> 8n) + (P7 << 4n);
  return Number(BigInt.asUintN(32, p));
}

/** 4.2.3: humidity in %RH × 1024 (Q22.10) for a raw word, with t_fine. */
export function compensateH(adcH: number, tFine: number): number {
  let v = (tFine - 76800) | 0;
  const a = (((adcH << 14) - (C.H4 << 20) - Math.imul(C.H5, v) + 16384) | 0) >> 15;
  const b = (Math.imul((Math.imul(Math.imul(v, C.H6) >> 10, (Math.imul(v, C.H3) >> 11) + 32768) >> 10) + 2097152, C.H2) + 8192) >> 14;
  v = Math.imul(a, b);
  v = (v - (Math.imul(Math.imul(v >> 15, v >> 15) >> 7, C.H1) >> 4)) | 0;
  v = v < 0 ? 0 : v > 419430400 ? 419430400 : v;
  return v >> 12;
}

/** The smallest x in [lo, hi] where f(x) ≥ target (f increasing), or the one nearer to it below. */
function nearest(f: (x: number) => number, target: number, lo: number, hi: number, decreasing = false): number {
  const g = decreasing ? (x: number): number => -f(x) : f;
  const goal = decreasing ? -target : target;
  let a = lo;
  let b = hi;
  while (a < b) {
    const m = (a + b) >> 1;
    if (g(m) < goal) a = m + 1;
    else b = m;
  }
  if (a > lo && Math.abs(g(a - 1) - goal) <= Math.abs(g(a) - goal)) return a - 1;
  return a;
}

/** The 20-bit temperature word that reads `celsius`. */
export function rawTemperature(celsius: number): number {
  return nearest((x) => compensateT(x).t, Math.round(celsius * 100), 0, 0xfffff);
}

/** The 20-bit pressure word that reads `hpa` at this t_fine. */
export function rawPressure(hpa: number, tFine: number): number {
  return nearest((x) => compensateP(x, tFine), Math.round(hpa * 100 * 256), 0, 0xfffff, true);
}

/** The 16-bit humidity word that reads `percent` at this t_fine. */
export function rawHumidity(percent: number, tFine: number): number {
  return nearest((x) => compensateH(x, tFine), Math.round(percent * 1024), 0, 0xffff);
}

/** Table 27: t_sb → standby ns (BME280; codes 6 and 7 differ on the BMP280). */
const STANDBY_MS = [0.5, 62.5, 125, 250, 500, 1000, 10, 20] as const;
const BMP280_STANDBY_MS = [0.5, 62.5, 125, 250, 500, 1000, 2000, 4000] as const;
/** osrs code → oversampling factor (0 skipped; 5 and up ×16). */
const OVERSAMPLE = [0, 1, 2, 4, 8, 16, 16, 16] as const;
/** filter code → coefficient (0 off; 4 and up 16). */
const FILTER = [0, 2, 4, 8, 16, 16, 16, 16] as const;

/** Appendix B's maximum measurement time, ms. */
export function measurementMs(osrsT: number, osrsP: number, osrsH: number): number {
  const t = OVERSAMPLE[osrsT & 7];
  const p = OVERSAMPLE[osrsP & 7];
  const h = OVERSAMPLE[osrsH & 7];
  return 1.25 + (t > 0 ? 2.3 * t : 0) + (p > 0 ? 2.3 * p + 0.575 : 0) + (h > 0 ? 2.3 * h + 0.575 : 0);
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const high = (s: NetState): boolean => s.level === 1;

/** The calibration bytes 0x88–0xA1 and 0xE1–0xE7 (Table 16). */
function calibrationBytes(regs: Uint8Array): void {
  const word = (at: number, v: number): void => {
    regs[at] = v & 0xff;
    regs[at + 1] = (v >> 8) & 0xff;
  };
  word(0x88, C.T1);
  word(0x8a, C.T2);
  word(0x8c, C.T3);
  word(0x8e, C.P1);
  word(0x90, C.P2);
  word(0x92, C.P3);
  word(0x94, C.P4);
  word(0x96, C.P5);
  word(0x98, C.P6);
  word(0x9a, C.P7);
  word(0x9c, C.P8);
  word(0x9e, C.P9);
  regs[0xa1] = C.H1;
  word(0xe1, C.H2);
  regs[0xe3] = C.H3;
  regs[0xe4] = (C.H4 >> 4) & 0xff;
  regs[0xe5] = (C.H4 & 0x0f) | ((C.H5 & 0x0f) << 4);
  regs[0xe6] = (C.H5 >> 4) & 0xff;
  regs[0xe7] = C.H6 & 0xff;
}

function sensorModel(ctx: PartContext, props: PartProps, humidity: boolean) {
  const vcc = ctx.pin('VCC');
  const gnd = ctx.pin('GND');
  const csb = ctx.pin('CSB');
  const sdo = ctx.pin('SDO');
  const regs = new Uint8Array(256);
  const standby = humidity ? STANDBY_MS : BMP280_STANDBY_MS;
  let temperature = clamp(Number(props.temperature), -40, 85);
  let relative = clamp(Number(props.humidity ?? 0), 0, 100);
  let pressure = clamp(Number(props.pressure), 300, 1100);
  let powered = false;
  let spiLocked = false;
  let selected = false;
  /** ctrl_hum as of the last ctrl_meas write. */
  let osrsH = 0;
  let timer = -1;
  let filterT = -1;
  let filterP = -1;
  /** The raw words for the current values (recomputed when they change). */
  let cached = '';
  let wordT = 0;
  let wordP = 0;
  let wordH = 0;
  let pointer = 0;
  let writing = -1;
  /** SPI frame: −1 waiting for a control byte, else the register being written; reading after. */
  let spiWrite = -1;
  let spiRead = false;
  let busy = false;
  const visual = { temperature, humidity: humidity ? relative : 0, pressure, measuring: false };

  const rawWords = (): void => {
    const key = `${temperature}|${pressure}|${relative}`;
    if (key === cached) return;
    cached = key;
    wordT = rawTemperature(temperature);
    const tFine = compensateT(wordT).tFine;
    wordP = rawPressure(pressure, tFine);
    wordH = humidity ? rawHumidity(relative, tFine) : 0x8000;
  };

  const powerOn = (): void => {
    if (timer >= 0) ctx.cancel(timer);
    timer = -1;
    regs.fill(0);
    calibrationBytes(regs);
    regs[0xd0] = humidity ? 0x60 : 0x58;
    regs[0xf7] = 0x80;
    regs[0xfa] = 0x80;
    regs[0xfd] = 0x80;
    osrsH = 0;
    filterT = -1;
    filterP = -1;
    busy = false;
    visual.measuring = false;
  };

  /** A finished measurement: the words, oversampled, filtered, into the data registers. */
  const store = (): void => {
    rawWords();
    const ctrl = regs[0xf4];
    const osT = (ctrl >> 5) & 7;
    const osP = (ctrl >> 2) & 7;
    const coeff = FILTER[(regs[0xf5] >> 2) & 7];
    const quantize = (word: number, os: number): number => {
      const bits = 15 + Math.min(5, os);
      return (word >> (20 - bits)) << (20 - bits);
    };
    let t = 0x80000;
    let p = 0x80000;
    if (osT > 0) {
      t = quantize(wordT, osT);
      if (coeff > 0) {
        filterT = filterT < 0 ? wordT : Math.floor((filterT * (coeff - 1) + wordT) / coeff);
        t = filterT;
      }
    }
    if (osP > 0) {
      p = quantize(wordP, osP);
      if (coeff > 0) {
        filterP = filterP < 0 ? wordP : Math.floor((filterP * (coeff - 1) + wordP) / coeff);
        p = filterP;
      }
    }
    regs[0xf7] = p >> 12;
    regs[0xf8] = (p >> 4) & 0xff;
    regs[0xf9] = (p & 0x0f) << 4;
    regs[0xfa] = t >> 12;
    regs[0xfb] = (t >> 4) & 0xff;
    regs[0xfc] = (t & 0x0f) << 4;
    if (humidity) {
      const h = osrsH > 0 ? wordH : 0x8000;
      regs[0xfd] = h >> 8;
      regs[0xfe] = h & 0xff;
    }
  };

  const measureNs = (): number => {
    const ctrl = regs[0xf4];
    return Math.round(measurementMs((ctrl >> 5) & 7, (ctrl >> 2) & 7, humidity ? osrsH : 0) * 1e6);
  };
  /** One preallocated callback: a measurement ends (forced: back to sleep; normal: standby, then the next). */
  const step = (): void => {
    timer = -1;
    if (!powered) return;
    const mode = regs[0xf4] & 3;
    if (busy) {
      busy = false;
      store();
      visual.measuring = false;
      ctx.invalidate();
      if (mode === 3) timer = ctx.schedule(Math.round(standby[(regs[0xf5] >> 5) & 7] * 1e6), step);
      else regs[0xf4] &= ~3; // forced: done, asleep
      return;
    }
    if (mode !== 3) return;
    busy = true;
    visual.measuring = true;
    timer = ctx.schedule(measureNs(), step);
  };
  const startMode = (): void => {
    if (timer >= 0) ctx.cancel(timer);
    timer = -1;
    busy = false;
    visual.measuring = false;
    const mode = regs[0xf4] & 3;
    if (mode === 0) return;
    busy = true;
    visual.measuring = true;
    timer = ctx.schedule(measureNs(), step);
  };

  const readReg = (r: number): number => {
    if (r === 0xf3) return busy ? 0x08 : 0;
    if (r === 0xe0) return 0;
    if (!humidity && (r === 0xf2 || r >= 0xfd || (r >= 0xe1 && r <= 0xe7) || r === 0xa1)) return 0;
    return regs[r];
  };
  const writeReg = (r: number, v: number): void => {
    if (r === 0xe0) {
      if (v === 0xb6) powerOn();
      return;
    }
    if (r === 0xf2) {
      if (humidity) regs[0xf2] = v & 7;
      return;
    }
    if (r === 0xf4) {
      regs[0xf4] = v;
      osrsH = regs[0xf2] & 7;
      startMode();
      return;
    }
    if (r === 0xf5) regs[0xf5] = v & 0xfd;
  };

  const address = (): number => (high(sdo.read()) ? 0x77 : 0x76);
  const i2c: I2cDevice = {
    get address() {
      return address();
    },
    start(read: boolean): boolean {
      if (!powered || spiLocked) return false;
      writing = read ? -2 : -1;
      return true;
    },
    write(byte: number): boolean {
      if (writing === -1) {
        pointer = byte;
        writing = byte; // the next byte is its data
        return true;
      }
      writeReg(writing, byte);
      writing = -1;
      return true;
    },
    read(): number {
      const v = readReg(pointer);
      pointer = (pointer + 1) & 0xff;
      return v;
    },
    stop() {
      writing = -1;
    },
  };
  const spi: SpiDevice = {
    transfer(mosi: number): number {
      if (!powered) return 0xff;
      if (spiRead) {
        const v = readReg(pointer);
        pointer = (pointer + 1) & 0xff;
        return v;
      }
      if (spiWrite >= 0) {
        writeReg(spiWrite, mosi);
        spiWrite = -1;
        return 0xff;
      }
      const reg = (mosi & 0x7f) | 0x80;
      if (mosi & 0x80) {
        spiRead = true;
        pointer = reg;
      } else spiWrite = reg;
      return 0xff;
    },
  };
  ctx.attachI2c('SDA', 'SCL', i2c);
  ctx.attachSpi({ sck: 'SCL', mosi: 'SDA', miso: 'SDO', cs: 'CSB' }, spi);

  csb.onChange((s) => {
    const low = s.level === 0;
    if (low === selected) return;
    selected = low;
    if (low && powered) spiLocked = true;
    spiWrite = -1;
    spiRead = false;
  });
  const checkPower = (): void => {
    const v = vcc.read();
    const g = gnd.read();
    const on = v.level === 1 && g.level === 0 && v.volts - g.volts >= 1.71;
    // The board's pull-up on CSB and pull-down on SDO.
    if (on) {
      csb.driveVolts(v.volts, Strength.weak);
      sdo.drive(0, Strength.weak);
    } else {
      csb.release();
      sdo.release();
    }
    if (on === powered) return;
    powered = on;
    spiLocked = false;
    powerOn();
    ctx.invalidate();
  };
  vcc.onChange(checkPower);
  gnd.onChange(checkPower);
  checkPower();

  return {
    input(event: PartInput) {
      const channel = readChannelInput(event);
      if (channel === null) return;
      if (channel.channel === 'temperature') temperature = clamp(channel.value, -40, 85);
      else if (channel.channel === 'pressure') pressure = clamp(channel.value, 300, 1100);
      else if (channel.channel === 'humidity' && humidity) relative = clamp(channel.value, 0, 100);
      else return;
      visual.temperature = temperature;
      visual.pressure = pressure;
      visual.humidity = humidity ? relative : 0;
      ctx.invalidate();
    },
    visual: () => visual,
    reset() {
      temperature = clamp(Number(props.temperature), -40, 85);
      relative = clamp(Number(props.humidity ?? 0), 0, 100);
      pressure = clamp(Number(props.pressure), 300, 1100);
      visual.temperature = temperature;
      visual.humidity = humidity ? relative : 0;
      visual.pressure = pressure;
      timer = -1;
      powered = false;
      selected = false;
      checkPower();
    },
  };
}

const PINS = ['VCC', 'GND', 'SCL', 'SDA', 'CSB', 'SDO'] as const;
const MODULE = { w: 15.24, h: 11.43 };
const modulePins = PINS.map((name, i) => ({ name, x: 1.27 + 2.54 * i, y: 10.16, role: name === 'VCC' ? ('power' as const) : name === 'GND' ? ('ground' as const) : ('digital' as const) }));

export const bme280 = definePart({
  type: 'bme280',
  title: 'BME280 temperature, humidity and pressure sensor',
  category: 'sensors',
  size: MODULE,
  pins: modulePins,
  defaults: { temperature: 22, humidity: 45, pressure: 1013.25 },
  createModel: (ctx, props) => sensorModel(ctx, props as PartProps, true),
});

export const bmp280 = definePart({
  type: 'bmp280',
  title: 'BMP280 temperature and pressure sensor',
  category: 'sensors',
  size: MODULE,
  pins: modulePins,
  defaults: { temperature: 22, pressure: 1013.25 },
  createModel: (ctx, props) => sensorModel(ctx, props as PartProps, false),
});

