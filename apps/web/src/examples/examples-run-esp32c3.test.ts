import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample } from './run.test-helper.ts';

// BT94: every ESP32-C3 example runs 2 s of simulated time in Node (the C3's real ROM, a direct
// boot) and does what its card says.

const brightness = (r: ExampleRun, part: string): number => (r.visual(part)?.brightness as number | undefined) ?? 0;

export const ESP32C3_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'esp32c3-rgb-blink'(r) {
    r.runTo(2000);
    const colors = new Set(r.history('c3').map(({ visual }) => ((visual.pixels as number[] | undefined) ?? [0])[0]));
    for (const color of [0xff0000, 0x00ff00, 0x0000ff, 0x404040]) expect(colors).toContain(color);
  },
  'esp32c3-serial-hello'(r) {
    r.runTo(2000);
    expect(r.serial('c3')).toContain('hello from esp32c3');
    expect(r.serial('c3')).toContain('tick 1');
  },
  'esp32c3-pot-led'(r) {
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
  'esp32c3-oled-clock'(r) {
    r.runTo(2000);
    expect(r.serial('c3')).toContain('2026-01-01 00:00:01');
    expect(((r.visual('oled')?.fb ?? []) as number[]).some((v) => v !== 0)).toBe(true);
  },
  // BT108: the C3's WiFi — its symbols come with the example (run.test-helper reads the .syms.tsv).
  'esp32c3-wifi-rgb-server'(r) {
    r.runTo(2000);
    expect(r.serial('c3')).toContain('server at 192.168.4.2');
    const pixel = (): number => ((r.visual('c3')?.pixels as number[] | undefined) ?? [-1])[0];
    let t = 2000;
    for (const [client, color] of [['green', 0x00ff00], ['blue', 0x0000ff], ['red', 0xff0000], ['off', 0]] as const) {
      r.input(client, { kind: 'press' });
      r.runTo((t += 100));
      expect(pixel(), client).toBe(color);
      expect(r.serial('c3')).toContain(`led ${client}`);
    }
  },
};

describe('every ESP32-C3 example runs as described (BT94)', () => {
  const withC3 = EXAMPLES.filter((e) => Object.values(e.boards).some((b) => 'firmware' in b && b.firmware.startsWith('esp32c3/')));
  it('has a check for each', () => {
    expect(withC3.length).toBe(5);
    expect(withC3.map((e) => e.id).filter((id) => ESP32C3_CHECKS[id] === undefined)).toEqual([]);
  });
  for (const example of withC3) {
    it(
      example.id,
      () => {
        const check = ESP32C3_CHECKS[example.id];
        if (check === undefined) throw new Error(`no check for ${example.id}`);
        check(runExample(example));
      },
      60_000,
    );
  }
});
