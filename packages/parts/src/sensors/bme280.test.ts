import { Bench, type I2cDevice, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { FakeMcu, type FakeStep, fakeBoard, makeBenchEnv, testDoc } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { bme280, bmp280, compensateH, compensateP, compensateT, measurementMs, rawHumidity, rawPressure, rawTemperature } from './bme280.ts';

// BT191: the BME280/BMP280 against Bosch's datasheet — the compensation, the inverted raw words, and
// the register model on a bench with scripted I2C and SPI controllers.

const PINS = ['SDA', 'SCL', 'SCK', 'MOSI', 'MISO', 'D10', 'D9'];
const board = fakeBoard('fake-uno', PINS);

function bench(doc: ProjectDoc, script: readonly FakeStep[] = []) {
  const mcu = new FakeMcu({ pins: PINS, script, i2c: [{ sda: 'SDA', scl: 'SCL' }], spi: [{ sck: 'SCK', mosi: 'MOSI', miso: 'MISO' }] });
  return { mcu, bench: new Bench(doc, makeBenchEnv([board, bme280, bmp280], () => mcu)) };
}

const i2cDoc = (type = 'bme280', sdo?: string, props: Record<string, unknown> = {}): ProjectDoc =>
  testDoc(
    { uno: 'fake-uno', s: type },
    [['uno:SDA', 's:SDA'], ['uno:SCL', 's:SCL'], ['s:VCC', 'uno:5V'], ['s:GND', 'uno:GND'], ...(sdo === undefined ? [] : [[`s:SDO`, sdo] as [string, string]])],
    { s: props as never },
  );

/** Register reads and writes on an I2C device, as a library does them. */
function regs(device: I2cDevice) {
  return {
    write(reg: number, value: number): void {
      expect(device.start(false)).toBe(true);
      device.write(reg);
      device.write(value);
      device.stop();
    },
    read(reg: number, count: number): number[] {
      expect(device.start(false)).toBe(true);
      device.write(reg);
      expect(device.start(true)).toBe(true);
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(device.read(i < count - 1));
      device.stop();
      return out;
    },
  };
}

/** Temperature (0.01 °C), pressure (Pa) and humidity (%RH) from the eight data bytes, as the datasheet's code reads them. */
function decode(d: readonly number[]): { t: number; p: number; h: number } {
  const adcP = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4);
  const adcT = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4);
  const adcH = (d[6] << 8) | d[7];
  const { t, tFine } = compensateT(adcT);
  return { t, p: compensateP(adcP, tFine) / 256, h: compensateH(adcH, tFine) / 1024 };
}

describe('BME280 / BMP280 compensation (BT191)', () => {
  it('reproduces the BMP280 datasheet’s worked example with its trimming words', () => {
    const { t, tFine } = compensateT(519888);
    expect(t).toBe(2508);
    expect(tFine).toBe(128422);
    expect(compensateP(415148, tFine) / 256).toBeCloseTo(100653.27, 1);
  });

  it('finds raw words that read back the set values across the ranges', () => {
    for (const c of [-40, -12.34, 0, 21.5, 37.77, 85]) expect(compensateT(rawTemperature(c)).t, `${c} °C`).toBe(Math.round(c * 100));
    for (const c of [-20, 22, 60]) {
      const tFine = compensateT(rawTemperature(c)).tFine;
      for (const hpa of [300, 845.5, 1013.25, 1100]) expect(compensateP(rawPressure(hpa, tFine), tFine) / 25600, `${hpa} hPa at ${c} °C`).toBeCloseTo(hpa, 2);
      for (const rh of [0, 12.5, 45, 99.9]) expect(Math.abs(compensateH(rawHumidity(rh, tFine), tFine) / 1024 - rh), `${rh} % at ${c} °C`).toBeLessThan(0.01);
    }
  });

  it('takes the datasheet’s maximum measurement time (Appendix B)', () => {
    expect(measurementMs(1, 3, 0)).toBeCloseTo(13.325, 9); // its example: T ×1, P ×4, no H
    expect(measurementMs(5, 5, 5)).toBeCloseTo(1.25 + 36.8 + 37.375 + 37.375, 9);
  });
});

describe('BME280 / BMP280 registers on a bench (BT191)', () => {
  it('answers at 0x76 (the board pulls SDO down) or 0x77 (SDO high), with its chip id and power-up data', () => {
    for (const [sdo, address] of [
      [undefined, 0x76],
      ['uno:5V', 0x77],
    ] as const) {
      const { mcu } = bench(i2cDoc('bme280', sdo));
      const device = mcu.i2cControllers[0].attached[0];
      expect(device.address).toBe(address);
      const r = regs(device);
      expect(r.read(0xd0, 1)).toEqual([0x60]);
      expect(r.read(0xf7, 8)).toEqual([0x80, 0, 0, 0x80, 0, 0, 0x80, 0]);
      expect(r.read(0x88, 2)).toEqual([27504 & 0xff, 27504 >> 8]);
    }
    const { mcu } = bench(i2cDoc('bmp280'));
    expect(regs(mcu.i2cControllers[0].attached[0]).read(0xd0, 1)).toEqual([0x58]);
  });

  it('measures once in forced mode — measuring for the maximum time — and goes back to sleep', () => {
    const { mcu, bench: b } = bench(i2cDoc('bme280', undefined, { temperature: 23.45, humidity: 61.2, pressure: 987.6 }));
    const r = regs(mcu.i2cControllers[0].attached[0]);
    r.write(0xf2, 0x01); // humidity ×1
    r.write(0xf4, (5 << 5) | (5 << 2) | 1); // T ×16, P ×16, forced
    const t = measurementMs(5, 5, 1);
    expect(r.read(0xf3, 1)).toEqual([0x08]);
    b.runUntil(Math.floor(t * NS_PER_MS) - 1000);
    expect(r.read(0xf3, 1)).toEqual([0x08]);
    b.runUntil(Math.ceil(t * NS_PER_MS) + 1000);
    expect(r.read(0xf3, 1)).toEqual([0]);
    expect(r.read(0xf4, 1)[0] & 3).toBe(0); // asleep again
    const v = decode(r.read(0xf7, 8));
    expect(v.t).toBe(2345);
    expect(v.p / 100).toBeCloseTo(987.6, 2);
    expect(Math.abs(v.h - 61.2)).toBeLessThan(0.01);
    // A new temperature shows at the next measurement, not before.
    b.input('s', { kind: 'key', key: 'set:temperature=-5.5', down: true });
    expect(decode(r.read(0xf7, 8)).t).toBe(2345);
    r.write(0xf4, (5 << 5) | (5 << 2) | 2);
    b.runUntil(b.now() + 200 * NS_PER_MS);
    expect(decode(r.read(0xf7, 8)).t).toBe(-550);
  });

  it('oversampling ×1 gives 16-bit words, a skipped channel reads 0x80000, the filter makes them 20-bit', () => {
    const { mcu, bench: b } = bench(i2cDoc('bme280', undefined, { temperature: 21.37 }));
    const r = regs(mcu.i2cControllers[0].attached[0]);
    r.write(0xf4, (1 << 5) | (0 << 2) | 1); // T ×1, P skipped, forced
    b.runUntil(20 * NS_PER_MS);
    const d = r.read(0xf7, 6);
    expect(d.slice(0, 3)).toEqual([0x80, 0, 0]);
    expect(d[5] & 0xf0).toBe(0); // 16 bits: no xlsb
    expect(Math.abs(decode([0x80, 0, 0, ...d.slice(3), 0, 0]).t - 2137)).toBeLessThanOrEqual(10);
    r.write(0xf5, 4 << 2); // filter ×16
    r.write(0xf4, (1 << 5) | 1);
    b.runUntil(40 * NS_PER_MS);
    expect(decode([0x80, 0, 0, ...r.read(0xfa, 3), 0, 0]).t).toBe(2137); // 20 bits again
  });

  it('runs normal mode every measurement + standby, the filter easing towards a step', () => {
    const { mcu, bench: b } = bench(i2cDoc('bmp280', undefined, { temperature: 20, pressure: 1000 }));
    const r = regs(mcu.i2cControllers[0].attached[0]);
    r.write(0xf5, (1 << 5) | (2 << 2)); // standby 62.5 ms, filter ×4
    r.write(0xf4, (2 << 5) | (5 << 2) | 3); // T ×2, P ×16, normal
    const period = measurementMs(2, 5, 0) + 62.5;
    b.runUntil(Math.round(3.5 * period * NS_PER_MS));
    expect(decode([...r.read(0xf7, 6), 0, 0]).p / 100).toBeCloseTo(1000, 1);
    b.input('s', { kind: 'key', key: 'set:pressure=1010', down: true });
    b.runUntil(b.now() + Math.round(period * NS_PER_MS));
    const one = decode([...r.read(0xf7, 6), 0, 0]).p / 100;
    expect(one).toBeGreaterThan(1001); // a quarter of the step
    expect(one).toBeLessThan(1004);
    b.runUntil(b.now() + Math.round(40 * period * NS_PER_MS));
    expect(decode([...r.read(0xf7, 6), 0, 0]).p / 100).toBeCloseTo(1010, 1);
    // Soft reset: back to sleep with the power-up words.
    r.write(0xe0, 0xb6);
    expect(r.read(0xf4, 1)).toEqual([0]);
    expect(r.read(0xf7, 3)).toEqual([0x80, 0, 0]);
  });

  it('talks SPI with CSB low (the read/write bit, pairs for writes), and then ignores I2C', () => {
    const script: FakeStep[] = [{ cycle: 16, pin: 'D10', mode: 'output', level: 1 }, { cycle: 32, pin: 'D10', mode: 'output', level: 0 }];
    const doc = testDoc({ uno: 'fake-uno', s: 'bme280' }, [
      ['uno:SCK', 's:SCL'],
      ['uno:MOSI', 's:SDA'],
      ['uno:MISO', 's:SDO'],
      ['uno:D10', 's:CSB'],
      ['s:VCC', 'uno:5V'],
      ['s:GND', 'uno:GND'],
    ]);
    const { mcu, bench: b } = bench(doc, script);
    b.runUntil(NS_PER_MS);
    const bus = mcu.spiControllers[0].attached[0].device;
    expect([bus.transfer(0xd0), bus.transfer(0)]).toEqual([0xff, 0x60]); // read id
    // A new frame: CSB up and down again, then a write pair (0xF4 & 0x7F) and a read.
    mcu.setScript([
      { cycle: 17_000, pin: 'D10', mode: 'output', level: 1 },
      { cycle: 17_016, pin: 'D10', mode: 'output', level: 0 },
    ]);
    b.runUntil(2 * NS_PER_MS);
    bus.transfer(0x74);
    bus.transfer(0x25);
    mcu.setScript([
      { cycle: 33_000, pin: 'D10', mode: 'output', level: 1 },
      { cycle: 33_016, pin: 'D10', mode: 'output', level: 0 },
    ]);
    b.runUntil(3 * NS_PER_MS);
    expect([bus.transfer(0xf4), bus.transfer(0)]).toEqual([0xff, 0x25]);
  });

  it('stops answering I2C once CSB has gone low, until power-off', () => {
    const doc = testDoc({ uno: 'fake-uno', s: 'bme280' }, [
      ['uno:SDA', 's:SDA'],
      ['uno:SCL', 's:SCL'],
      ['uno:D10', 's:CSB'],
      ['s:VCC', 'uno:5V'],
      ['s:GND', 'uno:GND'],
    ]);
    const { mcu, bench: b } = bench(doc, [
      { cycle: 16_000, pin: 'D10', mode: 'output', level: 0 },
      { cycle: 16_016, pin: 'D10', mode: 'input', level: 0 },
    ]);
    const device = mcu.i2cControllers[0].attached[0];
    b.runUntil(NS_PER_MS / 2);
    expect(device.start(false)).toBe(true); // CSB pulled up by the board: I2C
    device.stop();
    b.runUntil(2 * NS_PER_MS);
    expect(device.start(false)).toBe(false); // one low on CSB locked it into SPI
  });
});
