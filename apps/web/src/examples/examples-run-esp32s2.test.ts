import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample } from './run.test-helper.ts';

// BT150 (BT153: WiFi and sleep): every ESP32-S2 example runs 2 s of simulated time in Node (the S2's real ROM, a direct
// boot) and does what its card says.

const brightness = (r: ExampleRun, part: string): number => (r.visual(part)?.brightness as number | undefined) ?? 0;

export const ESP32S2_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'esp32s2-rgb-blink'(r) {
    r.runTo(2000);
    const colors = new Set(r.history('s2').map(({ visual }) => ((visual.pixels as number[] | undefined) ?? [0])[0]));
    for (const color of [0xff0000, 0x00ff00, 0x0000ff, 0x404040]) expect(colors).toContain(color);
  },
  'esp32s2-serial-hello'(r) {
    r.runTo(2000);
    expect(r.serial('s2')).toContain('hello from esp32s2');
    expect(r.serial('s2')).toContain('tick 1');
  },
  'esp32s2-pot-led'(r) {
    r.runTo(1000);
    const middle = brightness(r, 'led1');
    r.input('pot', { kind: 'value', value: 0.1 });
    r.runTo(1500);
    const low = brightness(r, 'led1');
    r.input('pot', { kind: 'value', value: 0.6 });
    r.runTo(2000);
    const high = brightness(r, 'led1');
    expect(low).toBeLessThan(middle);
    expect(high).toBeGreaterThan(middle);
  },
  'esp32s2-oled-clock'(r) {
    r.runTo(2000);
    expect(r.serial('s2')).toContain('2026-01-01 00:00:01');
    expect(((r.visual('oled')?.fb ?? []) as number[]).some((v) => v !== 0)).toBe(true);
  },
  // BT153: the S2's WiFi (its symbols come with the example: run.test-helper reads the .syms.tsv) and sleep.
  'esp32s2-wifi-rgb-server'(r) {
    r.runTo(2000);
    expect(r.serial('s2')).toContain('server at 192.168.4.2');
    const pixel = (): number => ((r.visual('s2')?.pixels as number[] | undefined) ?? [-1])[0];
    let t = 2000;
    for (const [client, color] of [['green', 0x00ff00], ['blue', 0x0000ff], ['red', 0xff0000], ['off', 0]] as const) {
      r.input(client, { kind: 'press' });
      r.runTo((t += 100));
      expect(pixel(), client).toBe(color);
      expect(r.serial('s2')).toContain(`led ${client}`);
    }
  },
  'esp32s2-deep-sleep'(r) {
    r.runTo(1000);
    expect(r.serial('s2')).toContain('boot 1: power-on, 0 presses');
    r.input('btn1', { kind: 'press' });
    r.runTo(1100);
    r.input('btn1', { kind: 'release' });
    r.runTo(2000);
    expect(r.serial('s2')).toContain('boot 2: button, 1 presses');
  },
};

describe('every ESP32-S2 example runs as described (BT150)', () => {
  const withS2 = EXAMPLES.filter((e) => Object.values(e.boards).some((b) => 'firmware' in b && b.firmware.startsWith('esp32s2/')));
  it('has a check for each', () => {
    expect(withS2.length).toBe(6);
    expect(withS2.map((e) => e.id).filter((id) => ESP32S2_CHECKS[id] === undefined)).toEqual([]);
  });
  for (const example of withS2) {
    it(example.id, () => {
      ESP32S2_CHECKS[example.id](runExample(example));
    }, 60_000);
  }
});
