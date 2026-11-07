import type { I2cDevice } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { bootS3Fixture } from '../test-support/boot.test-helper.ts';
import { S3_PAD_MODE, S3_SIG } from './gpio.ts';
import { REF_HZ } from './rtc-cntl.ts';
import type { Esp32s3Soc } from './soc.ts';

// BT125: the S3's peripherals under real firmware (fixtures/sketches/esp32s3/*).

const ms = (cycles: number): number => (cycles / REF_HZ) * 1000;
const run = (soc: Esp32s3Soc, seconds: number): void => {
  soc.runUntil(soc.time + seconds * REF_HZ);
};
const ns = (cycles: number): number => (cycles / REF_HZ) * 1e9;
const quiet = (soc: Esp32s3Soc) => soc.problems.problems.filter((p) => p.severity !== 'info');

/** Frequency (Hz) and duty (0–1) of a pin's edges between two times (seconds). */
function pwm(edges: [number, number][], from: number, to: number): { hz: number; duty: number } {
  const e = edges.filter(([t]) => t >= from * REF_HZ && t < to * REF_HZ);
  const rises = e.filter(([, l]) => l === 1).map(([t]) => t);
  const first = rises[0];
  const last = rises[rises.length - 1];
  let high = 0;
  for (let i = 0; i + 1 < e.length; i++) if (e[i][1] === 1 && e[i][0] >= first && e[i + 1][0] <= last) high += e[i + 1][0] - e[i][0];
  return { hz: ((rises.length - 1) * REF_HZ) / (last - first), duty: high / (last - first) };
}

/** GPIO `g`'s level changes as [time, level]. */
export function recordEdges(soc: Esp32s3Soc, g: number): [number, number][] {
  const edges: [number, number][] = [];
  let level = soc.pads.level[g];
  soc.pads.onPin = (pin) => {
    if (pin !== g || soc.pads.level[g] === level) return;
    level = soc.pads.level[g];
    edges.push([soc.now(), level]);
  };
  return edges;
}

describe('ESP32-S3 GPIO (BT125)', () => {
  it('blink: GPIO2 toggles every 500 ms as an output', () => {
    const { soc } = bootS3Fixture('blink');
    const edges = recordEdges(soc, 2);
    run(soc, 3.2);
    expect(soc.pads.mode[2]).toBe(S3_PAD_MODE.OUTPUT);
    expect(edges.length).toBeGreaterThanOrEqual(5);
    // The S3 is dual-core: loopTask never yields to IDLE on its core, so every interval is 500 ms.
    for (let i = 1; i < edges.length; i++) expect(Math.abs(ms(edges[i][0] - edges[i - 1][0]) - 500)).toBeLessThan(1.01);
    expect(quiet(soc)).toEqual([]);
  });

  it('gpio-interrupt: five FALLING presses on GPIO41 count to five; the LED on GPIO38 follows within 2 ms (the second GPIO word)', () => {
    const { soc, uart } = bootS3Fixture('gpio-interrupt');
    soc.gpio.setPadInput(41, 1); // released: the pull-up
    run(soc, 0.1);
    expect(soc.pads.mode[41]).toBe(S3_PAD_MODE.PULLUP);
    const led = recordEdges(soc, 38);
    for (let i = 0; i < 5; i++) {
      const pressed = soc.time;
      soc.gpio.setPadInput(41, 0);
      run(soc, 0.02);
      expect(led[led.length - 1][1]).toBe(1);
      expect(ms(led[led.length - 1][0] - pressed)).toBeLessThan(2);
      soc.gpio.setPadInput(41, 1);
      run(soc, 0.02);
      expect(led[led.length - 1][1]).toBe(0);
    }
    expect(uart[0]).toBe('count=1\ncount=2\ncount=3\ncount=4\ncount=5\n');
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S3 ADC (BT125)', () => {
  it('adc-read: ADC1 and ADC2 one-shot conversions through SENS — attenuation ranges, resolution, a voltage change', () => {
    const { soc, uart } = bootS3Fixture('adc-read');
    const volts: Record<number, number> = { 1: 1.24, 2: 0.62, 3: 3.3, 4: 0, 11: 2.48 };
    soc.padVolts = (g) => volts[g] ?? 0;
    run(soc, 0.3);
    const lines = uart[0].split('\n').filter((l) => l.startsWith('a='));
    expect(lines.length).toBeGreaterThan(5);
    // 1.24 V of 3.1 V (11 dB) is 0.4 of 4095; 0 dB's 0.95 V saturates; 10 bits drop the low two;
    // GPIO2 0.62 V, GPIO3 above the range, GPIO4 0 V, GPIO11 (ADC2 channel 0) 2.48 V.
    expect(lines[lines.length - 1]).toBe('a=1638 z=4095 r=409 c=819,4095,0,3276');
    for (const g of [1, 2, 3, 4, 11]) expect(soc.pads.mode[g]).toBe(S3_PAD_MODE.ANALOG);
    volts[1] = 0.3;
    volts[11] = 0;
    const before = uart[0].length;
    run(soc, 0.1);
    const after = uart[0].slice(before).split('\n').filter((l) => l.startsWith('a='));
    expect(after[after.length - 1]).toBe('a=396 z=1293 r=99 c=819,4095,0,0');
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S3 LEDC (BT125)', () => {
  it('ledc-fade: analogWrite at 1 kHz / 25 %, a 5 kHz channel at 50 % then 25 % from a period boundary', () => {
    const { soc, uart } = bootS3Fixture('ledc-fade');
    const a = recordEdges(soc, 4);
    run(soc, 0.4);
    const b = recordEdges(soc, 5);
    expect(uart[0]).toBe('ready\r\n');
    const fast = pwm(a, 0.3, 0.4);
    expect(fast.hz).toBeCloseTo(1000, 0);
    expect(Math.abs(fast.duty - 0.25)).toBeLessThan(0.005);
    run(soc, 0.6);
    const half = pwm(b, 0.5, 0.95);
    expect(half.hz).toBeCloseTo(5000, 0);
    expect(Math.abs(half.duty - 0.5)).toBeLessThan(0.005);
    run(soc, 0.3);
    const quarter = pwm(b, 1.05, 1.3);
    expect(Math.abs(quarter.duty - 0.25)).toBeLessThan(0.005);
    const rises = b.filter(([, l]) => l === 1).map(([t]) => t);
    for (let i = 1; i < rises.length; i++) expect(Math.abs(ns(rises[i] - rises[i - 1]) - 200_000)).toBeLessThan(30);
    expect(soc.pads.mode[4]).toBe(S3_PAD_MODE.PERIPHERAL);
    expect(quiet(soc)).toEqual([]);
  });
});

/** An I2C device that ACKs everything; reads give `value`. */
function device(address: number, read: () => number = () => 0xff): I2cDevice & { written: number[] } {
  const written: number[] = [];
  return { address, written, start: () => true, write: (b) => (written.push(b), true), read: () => read(), stop: () => {} };
}

describe('ESP32-S3 I2C (BT125)', () => {
  it('i2c-scan: each controller finds exactly its bus\'s devices, then reads a register back', () => {
    const { soc, uart } = bootS3Fixture('i2c-scan');
    const rtc = device(0x68, () => 0x42);
    soc.i2c[0].devices = [device(0x3c), rtc];
    soc.i2c[1].devices = [device(0x27)];
    for (const g of [8, 9, 39, 40]) soc.gpio.setPadInput(g, 1);
    run(soc, 1.3);
    expect(uart[0]).toBe('found 0x3C\nfound 0x68\nfound1 0x27\ndone\r\nsec=42\n');
    expect(rtc.written).toEqual([0]);
    expect([soc.pads.pinOfOutSignal(S3_SIG.I2C0_SDA), soc.pads.pinOfOutSignal(S3_SIG.I2C0_SCL)]).toEqual([8, 9]);
    expect([soc.pads.pinOfOutSignal(S3_SIG.I2C1_SDA), soc.pads.pinOfOutSignal(S3_SIG.I2C1_SCL)]).toEqual([39, 40]);
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S3 SPI2 (BT125)', () => {
  it('spi-loopback: every mode and bit order reaches a selected device on the IO_MUX pins; with CS high nothing does', () => {
    const { soc, uart } = bootS3Fixture('spi-loopback');
    let seen = 0;
    soc.spi2.devices = [{ device: { transfer: (m) => (seen++, ~m & 0xff) }, selected: () => soc.pads.mode[10] === S3_PAD_MODE.OUTPUT && soc.pads.level[10] === 0 }];
    run(soc, 0.5);
    expect(uart[0]).toBe('f1m sum=32640\nf8m sum=32640\nflsb sum=32640\nfm3 sum=32640\nnocs sum=4080\ndone\r\n');
    expect(seen).toBe(4 * 256);
    expect([soc.pads.pinOfOutSignal(S3_SIG.FSPICLK), soc.pads.pinOfOutSignal(S3_SIG.FSPID), soc.pads.pinOfInSignal(S3_SIG.FSPIQ)]).toEqual([12, 11, 13]);
  });
});

describe('ESP32-S3 RMT (BT125)', () => {
  it('rgb-blink: the DevKitC-1\'s WS2812 on GPIO48 gets red, green, blue, LED_BUILTIN white and off, with WS2812 timing (±50 ns)', () => {
    const { soc, uart } = bootS3Fixture('rgb-blink');
    const edges = recordEdges(soc, 48);
    run(soc, 2.4);
    expect(uart[0]).toBe('step 0\nstep 1\nstep 2\nstep 3\nstep 4\n');
    expect(soc.pads.mode[48]).toBe(S3_PAD_MODE.PERIPHERAL);
    const frames: { high: number; low: number }[][] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      if (edges[i][1] !== 1) continue;
      const high = ns(edges[i + 1][0] - edges[i][0]);
      const low = i + 2 < edges.length ? ns(edges[i + 2][0] - edges[i + 1][0]) : Number.POSITIVE_INFINITY;
      if (frames.length === 0 || ns(edges[i][0] - edges[i - 1][0]) > 50_000) frames.push([]);
      frames[frames.length - 1].push({ high, low });
    }
    const colors = frames.map((frame) => {
      expect(frame.length).toBe(24);
      let grb = 0;
      frame.forEach(({ high, low }, bit) => {
        const one = high > 600;
        expect(Math.abs(high - (one ? 800 : 400))).toBeLessThanOrEqual(50);
        if (bit < 23) expect(Math.abs(low - (one ? 400 : 800))).toBeLessThanOrEqual(50);
        grb = (grb << 1) | (one ? 1 : 0);
      });
      return [(grb >>> 8) & 0xff, (grb >>> 16) & 0xff, grb & 0xff];
    });
    expect(colors).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [64, 64, 64],
      [0, 0, 0],
    ]);
    expect(quiet(soc)).toEqual([]);
  });
});

describe('ESP32-S3 serial (BT125)', () => {
  it('serial-echo: UART0 and UART1 (GPIO18 RX / GPIO17 TX through the matrix) echo lines uppercased', () => {
    const { soc, uart } = bootS3Fixture('serial-echo');
    run(soc, 0.3);
    soc.uarts[0].receive(new TextEncoder().encode('abc\n'));
    soc.uarts[1].receive(new TextEncoder().encode(`${'q'.repeat(200)}\n`));
    run(soc, 0.4);
    expect(uart[0]).toBe('ready\r\n> ABC\r\n');
    expect(uart[1]).toBe(`> ${'Q'.repeat(200)}\r\n`);
    expect(soc.pads.pinOfOutSignal(S3_SIG.U1TXD)).toBe(17);
    expect(soc.pads.pinOfInSignal(S3_SIG.U1RXD)).toBe(18);
  });

  it('cdc-hello: with CDCOnBoot=cdc, Serial is the USB-Serial-JTAG port — output, a tick a second, and input', () => {
    const { soc, uart } = bootS3Fixture('cdc-hello');
    let usb = '';
    soc.usb.onTx = (b) => (usb += String.fromCharCode(b));
    run(soc, 1.2);
    soc.usb.receive(new TextEncoder().encode('hi there\n'));
    run(soc, 1.1);
    expect(usb).toBe('hello over usb\r\ntick 1\n> hi there\r\ntick 2\n');
    expect(uart[0]).toBe('');
    expect(quiet(soc)).toEqual([]);
  });
});
