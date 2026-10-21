/**
 * DHT22 / AM2302 temperature and humidity sensor (Aosong datasheet). The data pin is open
 * drain: the sensor drives a strong 0 or releases (hiz); the MCU's pull-up (INPUT_PULLUP in both
 * installed libraries) or an external resistor makes the 1.
 *
 * A start is the line held low by someone else for ≥ 0.8 ms (Adafruit DHT 1.4.6 holds 1.1 ms,
 * DHTlib 1 ms — a 1.0 ms threshold would be flaky); shorter lows are ignored. 30 µs after the
 * release: low 80 µs, high 80 µs, then 40 bits MSB first, each low 50 µs then high 26 µs (0) or
 * 70 µs (1), then low 50 µs and release. Data: humidity×10 (uint16), temperature×10 with bit 15
 * as the sign and the magnitude in bits 0–14, then the checksum (sum of the 4 bytes & 0xFF).
 * Starts during a response are ignored; polling faster than every 2 s still answers (decided).
 *
 * Channels `temperature` (−40..80 °C) and `humidity` (0..100 %) arrive as channel inputs; props
 * hold the initial values. Visual: the values and `startUs`, the last start pulse's width. The
 * response is a chain of timers through one preallocated callback; a RunSplitter keeps MCU runs
 * short while a start pulse is in progress, so the 30 µs reply is exact. Pins from
 * @wokwi/elements 1.9.2 dht22-element (its data pin is named SDA).
 */

import { NS_PER_US, type PartContext, type PartInput, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { readChannelInput } from '../shared/channel-input.ts';
import { RunSplitter } from '../shared/run-splitter.ts';

export const DHT_START_MIN_NS = 800 * NS_PER_US;
const IDLE_SPLIT_NS = 200 * NS_PER_US;
const START_SPLIT_NS = 20 * NS_PER_US;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** The 5 bytes a DHT22 sends for these readings. */
export function dhtFrame(celsius: number, humidity: number): [number, number, number, number, number] {
  const h = Math.round(clamp(humidity, 0, 100) * 10);
  const t10 = Math.round(Math.abs(clamp(celsius, -40, 80)) * 10) & 0x7fff;
  const t = celsius < 0 && t10 !== 0 ? t10 | 0x8000 : t10;
  const bytes: [number, number, number, number, number] = [h >> 8, h & 0xff, t >> 8, t & 0xff, 0];
  bytes[4] = (bytes[0] + bytes[1] + bytes[2] + bytes[3]) & 0xff;
  return bytes;
}

/** Duration (ns) of response phase `phase` for `frame`: 0 low 80, 1 high 80, bits, end low 50. */
function phaseNs(phase: number, frame: readonly number[]): number {
  if (phase < 2) return 80 * NS_PER_US;
  if (phase < 82) {
    const bit = (phase - 2) >> 1;
    if ((phase & 1) === 0) return 50 * NS_PER_US;
    const one = (frame[bit >> 3] >> (7 - (bit & 7))) & 1;
    return (one ? 70 : 26) * NS_PER_US;
  }
  return 50 * NS_PER_US;
}

function dhtModel(ctx: PartContext, props: { temperature: number; humidity: number }) {
  const data = ctx.pin('SDA');
  const splitter = new RunSplitter(ctx);
  let temperature = clamp(props.temperature, -40, 80);
  let humidity = clamp(props.humidity, 0, 100);
  const frame: number[] = [0, 0, 0, 0, 0];
  let lowSince = -1;
  let responding = false;
  let phase = 0;
  let startUs = 0;
  // Phases: 0 low, 1 release, 2..81 bit low/high, 82 end low, 83 release (done).
  const step = (): void => {
    if (phase === 83) {
      data.release();
      responding = false;
      splitter.arm(IDLE_SPLIT_NS);
      return;
    }
    if ((phase & 1) === 0) data.drive(0, Strength.strong);
    else data.release();
    const next = phaseNs(phase, frame);
    phase++;
    ctx.schedule(next, step);
  };
  data.onChange((state) => {
    if (responding) return;
    const now = ctx.now();
    if (state.level === 0) {
      if (lowSince < 0) {
        lowSince = now;
        splitter.arm(START_SPLIT_NS);
      }
      return;
    }
    if (lowSince < 0) return;
    const width = now - lowSince;
    lowSince = -1;
    splitter.arm(IDLE_SPLIT_NS);
    if (width < DHT_START_MIN_NS) return;
    startUs = width / NS_PER_US;
    const bytes = dhtFrame(temperature, humidity);
    for (let i = 0; i < 5; i++) frame[i] = bytes[i];
    responding = true;
    phase = 0;
    ctx.schedule(30 * NS_PER_US, step);
    ctx.invalidate();
  });
  splitter.arm(IDLE_SPLIT_NS);
  return {
    input(event: PartInput) {
      const channel = readChannelInput(event);
      if (channel?.channel === 'temperature') temperature = clamp(channel.value, -40, 80);
      else if (channel?.channel === 'humidity') humidity = clamp(channel.value, 0, 100);
      else return;
      ctx.invalidate();
    },
    visual: () => ({ temperature, humidity, startUs }),
    reset() {
      temperature = clamp(props.temperature, -40, 80);
      humidity = clamp(props.humidity, 0, 100);
      lowSince = -1;
      responding = false;
      startUs = 0;
      data.release();
      splitter.reset();
      splitter.arm(IDLE_SPLIT_NS);
      ctx.invalidate();
    },
  };
}

export const dht22 = definePart({
  type: 'dht22',
  title: 'DHT22 temperature & humidity',
  category: 'sensors',
  size: { w: 15.1, h: 30.885 },
  pins: [
    { name: 'VCC', x: 3.969, y: 30.401, role: 'power' },
    { name: 'SDA', x: 6.482, y: 30.401, role: 'digital' },
    { name: 'NC', x: 9.022, y: 30.401, role: 'nc' },
    { name: 'GND', x: 11.589, y: 30.401, role: 'ground' },
  ],
  defaults: { temperature: 24, humidity: 40 },
  createModel: dhtModel,
});
