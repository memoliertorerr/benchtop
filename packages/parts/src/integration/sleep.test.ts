import { assembleBench, type Bench, type BenchEnv, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { esp32c3McuFactory } from '@benchtop/esp32c3';
import { esp32s2McuFactory } from '@benchtop/esp32s2';
import { esp32s3McuFactory } from '@benchtop/esp32s3';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { loadCachedC3Rom } from '../../../esp32c3/src/test-support/rom.test-helper.ts';
import { loadCachedS2Rom } from '../../../esp32s2/src/test-support/rom.test-helper.ts';
import { loadCachedS3Rom } from '../../../esp32s3/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT121: the ESP32's deep sleep on a full bench — fixtures/sketches/esp32/deep-sleep-timer (the RTC
// timer, a boot count in RTC_DATA_ATTR) and deep-sleep-pins (ext0 on GPIO33 LOW, ext1 on GPIO32
// HIGH, buttons on the bench). BT122: light sleep, and both on the ESP32-C3 (fixtures/sketches/
// esp32c3/deep-sleep and light-sleep on fixtures/projects/esp32c3-sleep.json, a button on GPIO4).
// BT128: the ESP32-S3 (the ESP32's sketches on fixtures/projects/esp32s3-sleep.json and
// esp32s3-deep-sleep-pins.json: ext0 on GPIO4, ext1 on GPIO5). BT152: the ESP32-S2, the same
// sketches on esp32s2-sleep.json and esp32s2-deep-sleep-pins.json.

const esp32 = esp32McuFactory(loadCachedRom());
const c3 = esp32c3McuFactory(loadCachedC3Rom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => esp32(board, id, report) };
const c3Env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => c3(board, id, report) };
const s3 = esp32s3McuFactory(loadCachedS3Rom());
const s3Env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => s3(board, id, report) };
const s2 = esp32s2McuFactory(loadCachedS2Rom());
const s2Env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => s2(board, id, report) };

function load(name: string, project = `esp32-${name}`, chip: 'esp32' | 'esp32c3' | 'esp32s3' | 'esp32s2' = 'esp32') {
  const doc = JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)) as ProjectDoc;
  const board = chip === 'esp32' ? 'esp' : chip === 'esp32c3' ? 'c3' : chip === 'esp32s3' ? 's3' : 's2';
  const bench: Bench = assembleBench(doc, chip === 'esp32' ? env : chip === 'esp32c3' ? c3Env : chip === 'esp32s3' ? s3Env : s2Env, { [board]: { format: 'esp32-bin', app: readFixture(`fixtures/firmware/${chip}/${name}.bin`), partitions: readFixture(`fixtures/firmware/${chip}/${name}.partitions.bin`) } });
  // Lines as they arrive, with the bench time (ms) their last byte came at.
  const lines: { t: number; text: string }[] = [];
  let partial = '';
  bench.onSerial(board, (bytes) => {
    partial += String.fromCharCode(...bytes);
    for (let nl = partial.indexOf('\n'); nl >= 0; nl = partial.indexOf('\n')) {
      lines.push({ t: bench.now() / NS_PER_MS, text: partial.slice(0, nl).replace(/\r$/, '') });
      partial = partial.slice(nl + 1);
    }
  });
  const runTo = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= ms; t += 10) bench.runUntil(t * NS_PER_MS);
  };
  return { bench, lines, runTo };
}

describe('ESP32 deep sleep (BT121)', () => {
  it('the RTC timer wakes it every 2 s; RTC_DATA_ATTR counts on; the woken app sees TIMER and DEEPSLEEP', () => {
    const r = load('deep-sleep-timer');
    r.runTo(7000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 reset 1', 'boot 2 cause 4 reset 8', 'boot 3 cause 4 reset 8', 'boot 4 cause 4 reset 8']);
    // 2 s asleep, plus the boot to setup() each time.
    for (let i = 2; i < r.lines.length; i++) expect(r.lines[i].t - r.lines[i - 1].t).toBeGreaterThan(2000);
    for (let i = 2; i < r.lines.length; i++) expect(r.lines[i].t - r.lines[i - 1].t).toBeLessThan(2400);
  }, 60_000);

  it('a pin wakes it — ext0 on GPIO33 LOW, ext1 on GPIO32 HIGH — and nothing else: an hour asleep costs no instructions', () => {
    const r = load('deep-sleep-pins');
    r.runTo(1000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 ext1 0']);
    const wall = performance.now();
    r.runTo(3_600_000); // an hour asleep: no wake
    expect(performance.now() - wall).toBeLessThan(5000);
    expect(r.lines).toHaveLength(1);
    // A tap (shorter than a boot): one wake. The wakes are levels, so a button held down wakes the
    // chip again each time it goes back to sleep — as on a board.
    r.bench.input('wake0', { kind: 'press' });
    r.runTo(3_600_010);
    r.bench.input('wake0', { kind: 'release' });
    r.runTo(3_601_000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 ext1 0', 'boot 2 cause 2 ext1 0']);
    r.bench.input('wake1', { kind: 'press' });
    r.runTo(3_601_010);
    r.bench.input('wake1', { kind: 'release' });
    r.runTo(3_602_000);
    expect(r.lines.map((l) => l.text).slice(2)).toEqual(['boot 3 cause 3 ext1 100000000']); // GPIO32's bit
    r.bench.input('wake0', { kind: 'press' });
    r.runTo(3_602_300);
    r.bench.input('wake0', { kind: 'release' });
    r.runTo(3_603_000);
    expect(r.lines.length).toBeGreaterThan(5); // held 300 ms: woken again and again
  }, 60_000);
});

describe('ESP32 light sleep (BT122)', () => {
  it('the timer wakes it ten times, RAM kept, millis() counting each sleep once; then a GPIO level wakes it, not before', () => {
    const r = load('light-sleep', 'esp32-button'); // the button on D4 to GND
    r.runTo(1500);
    const wakes = r.lines.filter((l) => l.text.startsWith('wake '));
    expect(wakes.map((l) => l.text.replace(/ millis \d+$/, ''))).toEqual(Array.from({ length: 10 }, (_, i) => `wake ${i + 1} cause 4`));
    const start = Number(/start millis (\d+)/.exec(r.lines[0].text)?.[1]);
    const millis = wakes.map((l) => Number(/millis (\d+)/.exec(l.text)?.[1]));
    millis.forEach((m, i) => expect(m - start).toBeGreaterThanOrEqual(100 * (i + 1)));
    millis.forEach((m, i) => expect(m - start).toBeLessThan(103 * (i + 1)));
    // And on the bench's clock: ten sleeps of 100 ms.
    expect(wakes[9].t - wakes[0].t).toBeGreaterThan(900);
    expect(wakes[9].t - wakes[0].t).toBeLessThan(930);
    // Waiting for D4 LOW: a minute passes (the watchdogs' clocks stopped with the APB clock).
    r.runTo(61_500);
    expect(r.lines.map((l) => l.text).filter((t) => t.startsWith('gpio'))).toEqual([]);
    expect(r.lines.filter((l) => l.text.startsWith('start'))).toHaveLength(1); // no reboot
    r.bench.input('btn1', { kind: 'press' });
    r.runTo(61_600);
    r.bench.input('btn1', { kind: 'release' });
    expect(r.lines.at(-1)?.text).toBe('gpio wake cause 7');
    // rtc_sleep_init powers the RF down through radio-block registers: no sign of a WiFi driver.
    expect(r.bench.problems().map((p) => p.code)).not.toContain('esp32-wifi-no-symbols');
  }, 60_000);
});


describe('ESP32-C3 sleep (BT122)', () => {
  it('deep sleep: the RTC timer every 2 s, a GPIO4 LOW wake from the button (GPIO_WAKEUP), RTC memory kept', () => {
    const r = load('deep-sleep', 'esp32c3-sleep', 'esp32c3');
    r.runTo(7000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 reset 1 pins 0', 'boot 2 cause 4 reset 8 pins 0', 'boot 3 cause 4 reset 8 pins 0', 'boot 4 cause 4 reset 8 pins 0']);
    for (let i = 2; i < r.lines.length; i++) expect(r.lines[i].t - r.lines[i - 1].t).toBeGreaterThan(2000);
    for (let i = 2; i < r.lines.length; i++) expect(r.lines[i].t - r.lines[i - 1].t).toBeLessThan(2400);
    // Mid-sleep, the button: woken at once by the pin (its status bit: GPIO4); the sketch waits for
    // the release, so holding it wakes the chip once.
    const before = r.lines.length;
    r.runTo(7500);
    r.bench.input('wake', { kind: 'press' });
    r.runTo(7800);
    r.bench.input('wake', { kind: 'release' });
    r.runTo(7900);
    expect(r.lines.slice(before).map((l) => l.text)).toEqual(['boot 5 cause 7 reset 8 pins 16']);
    expect(r.lines.at(-1)?.t).toBeLessThan(7600);
    // IDF isolates every pad for sleep at startup: no pin counts as read while floating for that.
    expect(r.bench.problems().map((p) => p.code)).not.toContain('esp32c3-floating-input');
    expect(r.bench.problems().find((p) => p.code === 'mcu-halted')).toBeUndefined();
  }, 60_000);

  it('light sleep: ten timer wakes with RAM kept and millis() counting each once, then a GPIO level', () => {
    const r = load('light-sleep', 'esp32c3-sleep', 'esp32c3');
    r.runTo(1500);
    const wakes = r.lines.filter((l) => l.text.startsWith('wake '));
    expect(wakes.map((l) => l.text.replace(/ millis \d+$/, ''))).toEqual(Array.from({ length: 10 }, (_, i) => `wake ${i + 1} cause 4`));
    const start = Number(/start millis (\d+)/.exec(r.lines[0].text)?.[1]);
    const millis = wakes.map((l) => Number(/millis (\d+)/.exec(l.text)?.[1]));
    millis.forEach((m, i) => expect(m - start).toBeGreaterThanOrEqual(100 * (i + 1)));
    millis.forEach((m, i) => expect(m - start).toBeLessThan(103 * (i + 1)));
    expect(wakes[9].t - wakes[0].t).toBeGreaterThan(900);
    expect(wakes[9].t - wakes[0].t).toBeLessThan(930);
    r.runTo(61_500);
    expect(r.lines.map((l) => l.text).filter((t) => t.startsWith('gpio'))).toEqual([]);
    expect(r.lines.filter((l) => l.text.startsWith('start'))).toHaveLength(1); // no reboot
    r.bench.input('wake', { kind: 'press' });
    r.runTo(61_600);
    r.bench.input('wake', { kind: 'release' });
    expect(r.lines.at(-1)?.text).toBe('gpio wake cause 7');
  }, 60_000);
});

describe('ESP32-S3 sleep (BT128)', () => {
  it('deep sleep: the RTC timer every 2 s; RTC_DATA_ATTR counts on; the woken app sees TIMER and DEEPSLEEP', () => {
    const r = load('deep-sleep-timer', 'esp32s3-sleep', 'esp32s3');
    r.runTo(7000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 reset 1', 'boot 2 cause 4 reset 8', 'boot 3 cause 4 reset 8', 'boot 4 cause 4 reset 8']);
    for (let i = 2; i < r.lines.length; i++) expect(r.lines[i].t - r.lines[i - 1].t).toBeGreaterThan(2000);
    for (let i = 2; i < r.lines.length; i++) expect(r.lines[i].t - r.lines[i - 1].t).toBeLessThan(2400);
    expect(r.bench.problems().find((p) => p.code === 'mcu-halted')).toBeUndefined();
  }, 60_000);

  it('a pin wakes it — ext0 on GPIO4 LOW (the RTC pull-up holds it high), ext1 on GPIO5 HIGH — and nothing else: an hour asleep costs no instructions', () => {
    const r = load('deep-sleep-pins', 'esp32s3-deep-sleep-pins', 'esp32s3');
    r.runTo(1000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 ext1 0']);
    const wall = performance.now();
    r.runTo(3_600_000); // an hour asleep: no wake
    expect(performance.now() - wall).toBeLessThan(5000);
    expect(r.lines).toHaveLength(1);
    r.bench.input('wake0', { kind: 'press' });
    r.runTo(3_600_010);
    r.bench.input('wake0', { kind: 'release' });
    r.runTo(3_601_000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 ext1 0', 'boot 2 cause 2 ext1 0']);
    r.bench.input('wake1', { kind: 'press' });
    r.runTo(3_601_010);
    r.bench.input('wake1', { kind: 'release' });
    r.runTo(3_602_000);
    expect(r.lines.map((l) => l.text).slice(2)).toEqual(['boot 3 cause 3 ext1 20']); // GPIO5's bit
  }, 60_000);

  it('light sleep: ten timer wakes with RAM kept and millis() counting each once, then a GPIO level, not before', () => {
    const r = load('light-sleep', 'esp32s3-sleep', 'esp32s3');
    r.runTo(1500);
    const wakes = r.lines.filter((l) => l.text.startsWith('wake '));
    expect(wakes.map((l) => l.text.replace(/ millis \d+$/, ''))).toEqual(Array.from({ length: 10 }, (_, i) => `wake ${i + 1} cause 4`));
    const start = Number(/start millis (\d+)/.exec(r.lines[0].text)?.[1]);
    const millis = wakes.map((l) => Number(/millis (\d+)/.exec(l.text)?.[1]));
    millis.forEach((m, i) => expect(m - start).toBeGreaterThanOrEqual(100 * (i + 1)));
    millis.forEach((m, i) => expect(m - start).toBeLessThan(103 * (i + 1)));
    expect(wakes[9].t - wakes[0].t).toBeGreaterThan(900);
    expect(wakes[9].t - wakes[0].t).toBeLessThan(930);
    r.runTo(61_500);
    expect(r.lines.map((l) => l.text).filter((t) => t.startsWith('gpio'))).toEqual([]);
    expect(r.lines.filter((l) => l.text.startsWith('start'))).toHaveLength(1); // no reboot
    r.bench.input('wake', { kind: 'press' });
    r.runTo(61_600);
    r.bench.input('wake', { kind: 'release' });
    expect(r.lines.at(-1)?.text).toBe('gpio wake cause 7');
    expect(r.bench.problems().map((p) => p.code)).not.toContain('esp32s3-wifi-no-symbols');
  }, 60_000);
});

describe('ESP32-S2 sleep (BT152)', () => {
  it('deep sleep: the RTC timer every 2 s; RTC_DATA_ATTR counts on; the woken app sees TIMER and DEEPSLEEP', () => {
    const r = load('deep-sleep-timer', 'esp32s2-sleep', 'esp32s2');
    r.runTo(7000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 reset 1', 'boot 2 cause 4 reset 8', 'boot 3 cause 4 reset 8', 'boot 4 cause 4 reset 8']);
    for (let i = 2; i < r.lines.length; i++) expect(r.lines[i].t - r.lines[i - 1].t).toBeGreaterThan(2000);
    for (let i = 2; i < r.lines.length; i++) expect(r.lines[i].t - r.lines[i - 1].t).toBeLessThan(2400);
    expect(r.bench.problems().find((p) => p.code === 'mcu-halted')).toBeUndefined();
  }, 60_000);

  it('a pin wakes it — ext0 on GPIO4 LOW (the RTC pull-up holds it high), ext1 on GPIO5 HIGH — and nothing else: an hour asleep costs no instructions', () => {
    const r = load('deep-sleep-pins', 'esp32s2-deep-sleep-pins', 'esp32s2');
    r.runTo(1000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 ext1 0']);
    const wall = performance.now();
    r.runTo(3_600_000); // an hour asleep: no wake
    expect(performance.now() - wall).toBeLessThan(5000);
    expect(r.lines).toHaveLength(1);
    r.bench.input('wake0', { kind: 'press' });
    r.runTo(3_600_010);
    r.bench.input('wake0', { kind: 'release' });
    r.runTo(3_601_000);
    expect(r.lines.map((l) => l.text)).toEqual(['boot 1 cause 0 ext1 0', 'boot 2 cause 2 ext1 0']);
    r.bench.input('wake1', { kind: 'press' });
    r.runTo(3_601_010);
    r.bench.input('wake1', { kind: 'release' });
    r.runTo(3_602_000);
    expect(r.lines.map((l) => l.text).slice(2)).toEqual(['boot 3 cause 3 ext1 20']); // GPIO5's bit
  }, 60_000);

  it('light sleep: ten timer wakes with RAM kept and millis() counting each once, then a GPIO level, not before', () => {
    const r = load('light-sleep', 'esp32s2-sleep', 'esp32s2');
    r.runTo(1500);
    const wakes = r.lines.filter((l) => l.text.startsWith('wake '));
    expect(wakes.map((l) => l.text.replace(/ millis \d+$/, ''))).toEqual(Array.from({ length: 10 }, (_, i) => `wake ${i + 1} cause 4`));
    const start = Number(/start millis (\d+)/.exec(r.lines[0].text)?.[1]);
    const millis = wakes.map((l) => Number(/millis (\d+)/.exec(l.text)?.[1]));
    millis.forEach((m, i) => expect(m - start).toBeGreaterThanOrEqual(100 * (i + 1)));
    millis.forEach((m, i) => expect(m - start).toBeLessThan(103 * (i + 1)));
    expect(wakes[9].t - wakes[0].t).toBeGreaterThan(900);
    expect(wakes[9].t - wakes[0].t).toBeLessThan(930);
    r.runTo(61_500);
    expect(r.lines.map((l) => l.text).filter((t) => t.startsWith('gpio'))).toEqual([]);
    expect(r.lines.filter((l) => l.text.startsWith('start'))).toHaveLength(1); // no reboot
    r.bench.input('wake', { kind: 'press' });
    r.runTo(61_600);
    r.bench.input('wake', { kind: 'release' });
    expect(r.lines.at(-1)?.text).toBe('gpio wake cause 7');
    expect(r.bench.problems().map((p) => p.code)).not.toContain('esp32s2-wifi-no-symbols');
  }, 60_000);
});
