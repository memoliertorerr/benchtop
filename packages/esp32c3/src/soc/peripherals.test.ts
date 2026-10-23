import type { I2cDevice } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { bootC3Fixture } from '../test-support/boot.test-helper.ts';
import { REF_HZ } from './context.ts';
import { PAD_MODE, SIG } from './gpio.ts';
import type { Esp32c3Soc } from './soc.ts';

const ms = (cycles: number): number => (cycles / REF_HZ) * 1000;
const ns = (cycles: number): number => (cycles / REF_HZ) * 1e9;
const run = (soc: Esp32c3Soc, seconds: number): void => soc.runUntil(soc.time + seconds * REF_HZ);

/** GPIO `g`'s level changes as [time, level] (mode changes that keep the level are left out). */
function recordEdges(soc: Esp32c3Soc, g: number): [number, number][] {
  const edges: [number, number][] = [];
  let level = soc.pads.level[g];
  soc.pads.onPin = (pin) => {
    if (pin !== g || soc.pads.level[g] === level) return;
    level = soc.pads.level[g];
    edges.push([soc.now(), level]);
  };
  return edges;
}

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

const quiet = (soc: Esp32c3Soc) => soc.problems.problems.filter((p) => p.severity !== 'info');

describe('ESP32-C3 GPIO (BT93)', () => {
  it('blink: GPIO8 toggles every 500 ms; the loop task\'s 5-tick yield every 2 s shows as one 505 ms interval', () => {
    const { soc } = bootC3Fixture('blink');
    const edges = recordEdges(soc, 8);
    run(soc, 10.2);
    expect(soc.pads.mode[8]).toBe(PAD_MODE.OUTPUT);
    // From the second interval on: the first delay starts part-way into a tick.
    const intervals = edges.slice(2).map(([t], i) => ms(t - edges[i + 1][0]));
    expect(intervals.length).toBeGreaterThanOrEqual(18);
    // Arduino-ESP32 2.0.17 on a single core: loopTask calls yieldIfNecessary(), a vTaskDelay(5)
    // whenever 2 s have passed — real C3 boards do the same.
    const long = intervals.filter((v) => Math.abs(v - 505) < 0.01);
    expect(intervals.every((v) => Math.abs(v - 500) < 0.01 || Math.abs(v - 505) < 0.01)).toBe(true);
    expect(long.length).toBeGreaterThanOrEqual(4);
    expect(long.length).toBeLessThanOrEqual(5);
    expect(quiet(soc)).toEqual([]);
  });

  it('gpio-interrupt: five FALLING presses on GPIO9 count to five; the LED on GPIO3 follows within 2 ms', () => {
    const { soc, uart } = bootC3Fixture('gpio-interrupt');
    soc.gpio.setPadInput(9, 1); // released: the pull-up
    run(soc, 0.1);
    expect(soc.pads.mode[9]).toBe(PAD_MODE.PULLUP);
    const led = recordEdges(soc, 3);
    for (let i = 0; i < 5; i++) {
      const pressed = soc.time;
      soc.gpio.setPadInput(9, 0);
      run(soc, 0.02);
      expect(led[led.length - 1][1]).toBe(1);
      expect(ms(led[led.length - 1][0] - pressed)).toBeLessThan(2);
      soc.gpio.setPadInput(9, 1);
      run(soc, 0.02);
      expect(led[led.length - 1][1]).toBe(0);
    }
    expect(uart[0]).toBe('count=1\ncount=2\ncount=3\ncount=4\ncount=5\n');
  });
});

describe('ESP32-C3 SAR ADC on the pins (BT93)', () => {
  it('adc-read: GPIO0–4 at their volts read the linear model\'s codes at 11 dB and 0 dB, and read as analog', () => {
    const { soc, uart } = bootC3Fixture('adc-read');
    const volts = [1.25, 0, 0.625, 1.875, 2.5, 0];
    soc.padVolts = (g) => volts[g];
    run(soc, 0.3);
    const last = (): string => uart[0].trimEnd().split('\n').pop() ?? '';
    expect(last()).toBe('a=2048 z=4095 r=512 c=0,1024,3071,4095');
    volts[0] = 0.375; // mid-scale at 0 dB (0.75 V full scale)
    run(soc, 0.1);
    expect(last()).toBe('a=614 z=2048 r=153 c=0,1024,3071,4095');
    expect([...soc.pads.mode.slice(0, 5)]).toEqual([PAD_MODE.ANALOG, PAD_MODE.ANALOG, PAD_MODE.ANALOG, PAD_MODE.ANALOG, PAD_MODE.ANALOG]);
  });
});

describe('ESP32-C3 LEDC (BT93)', () => {
  it('ledc-fade: analogWrite at 1 kHz / 25 %, a 5 kHz channel at 50 % then 25 % from a period boundary', () => {
    const { soc, uart } = bootC3Fixture('ledc-fade');
    const a = recordEdges(soc, 3);
    run(soc, 0.4);
    const b = recordEdges(soc, 4); // replaces GPIO3's recorder: GPIO3 is measured from 0.3 s to 0.4 s below
    expect(uart[0]).toBe('ready\r\n');
    const fast = pwm(a, 0.3, 0.4);
    expect(fast.hz).toBeCloseTo(1000, 0);
    expect(Math.abs(fast.duty - 0.25)).toBeLessThan(0.005);
    run(soc, 0.6); // to 1.0 s: still 50 %
    const half = pwm(b, 0.5, 0.95);
    expect(half.hz).toBeCloseTo(5000, 0);
    expect(Math.abs(half.duty - 0.5)).toBeLessThan(0.005);
    run(soc, 0.3); // the first switch, to 25 %, lands near 1.0 s
    const quarter = pwm(b, 1.05, 1.3);
    expect(quarter.hz).toBeCloseTo(5000, 0);
    expect(Math.abs(quarter.duty - 0.25)).toBeLessThan(0.005);
    // Every period is whole: the change waited for a boundary.
    const rises = b.filter(([, l]) => l === 1).map(([t]) => t);
    for (let i = 1; i < rises.length; i++) expect(Math.abs(ns(rises[i] - rises[i - 1]) - 200_000)).toBeLessThan(30);
    expect(soc.pads.mode[3]).toBe(PAD_MODE.PERIPHERAL);
  });
});

/** An I2C device that ACKs everything; reads give `value`. */
function device(address: number, read: () => number = () => 0xff): I2cDevice & { written: number[] } {
  const written: number[] = [];
  return { address, written, start: () => true, write: (b) => (written.push(b), true), read: () => read(), stop: () => {} };
}

describe('ESP32-C3 I2C (BT93)', () => {
  it('i2c-scan: finds exactly the devices on the bus, then reads a register back', () => {
    const { soc, uart } = bootC3Fixture('i2c-scan');
    const rtc = device(0x68, () => 0x42);
    soc.i2c.devices = [device(0x3c), rtc];
    soc.gpio.setPadInput(8, 1);
    soc.gpio.setPadInput(9, 1);
    run(soc, 1.2);
    expect(uart[0]).toBe('found 0x3C\nfound 0x68\ndone\r\nsec=42\n');
    expect(rtc.written).toEqual([0]);
    expect(soc.pads.pinOfOutSignal(SIG.I2C_SDA)).toBe(8);
    expect(soc.pads.pinOfOutSignal(SIG.I2C_SCL)).toBe(9);
    expect(quiet(soc)).toEqual([]);
  });

  it('i2c-scan with nothing attached: only "done", and the scan takes milliseconds, not timeouts', () => {
    const { soc, uart, sent } = bootC3Fixture('i2c-scan');
    soc.gpio.setPadInput(8, 1);
    soc.gpio.setPadInput(9, 1);
    run(soc, 0.5);
    expect(uart[0]).toBe('done\r\n');
    expect(sent[0][1] / REF_HZ).toBeLessThan(0.1);
  });
});

describe('ESP32-C3 SPI2 (BT93)', () => {
  it('spi-loopback: every mode and bit order reaches a selected device; with CS high nothing does', () => {
    const { soc, uart } = bootC3Fixture('spi-loopback');
    let seen = 0;
    soc.spi2.devices = [{ device: { transfer: (m) => (seen++, ~m & 0xff) }, selected: () => soc.pads.mode[7] === PAD_MODE.OUTPUT && soc.pads.level[7] === 0 }];
    run(soc, 0.5);
    expect(uart[0]).toBe('f1m sum=32640\nf8m sum=32640\nflsb sum=32640\nfm3 sum=32640\nnocs sum=4080\ndone\r\n');
    expect(seen).toBe(4 * 256);
    expect([soc.pads.pinOfOutSignal(SIG.FSPICLK), soc.pads.pinOfOutSignal(SIG.FSPID), soc.pads.pinOfInSignal(SIG.FSPIQ)]).toEqual([4, 6, 5]);
  });
});

describe('ESP32-C3 RMT (BT93)', () => {
  it('rgb-blink: the DevKitM-1\'s WS2812 on GPIO8 gets red, green, blue, LED_BUILTIN white and off, with WS2812 timing (±50 ns)', () => {
    const { soc, uart } = bootC3Fixture('rgb-blink');
    const edges = recordEdges(soc, 8);
    run(soc, 2.4);
    expect(uart[0]).toBe('step 0\nstep 1\nstep 2\nstep 3\nstep 4\n');
    expect(soc.pads.mode[8]).toBe(PAD_MODE.PERIPHERAL);
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
    // "Off" is 24 zero bits: still a frame of short pulses.
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

describe('ESP32-C3 serial (BT93)', () => {
  it('serial-echo: UART0 and UART1 (GPIO1 RX / GPIO0 TX through the matrix) echo lines uppercased', () => {
    const { soc, uart } = bootC3Fixture('serial-echo');
    run(soc, 0.3);
    soc.uarts[0].receive(new TextEncoder().encode('abc\n'));
    soc.uarts[1].receive(new TextEncoder().encode(`${'q'.repeat(200)}\n`));
    run(soc, 0.4);
    expect(uart[0]).toBe('ready\r\n> ABC\r\n');
    expect(uart[1]).toBe(`> ${'Q'.repeat(200)}\r\n`);
    expect(soc.pads.pinOfOutSignal(SIG.U1TXD)).toBe(0);
    expect(soc.pads.pinOfInSignal(SIG.U1RXD)).toBe(1);
  });

  it('cdc-hello: with CDCOnBoot=cdc, Serial is the USB-Serial-JTAG port — output, a tick a second, and input', () => {
    const { soc, uart } = bootC3Fixture('cdc-hello');
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
