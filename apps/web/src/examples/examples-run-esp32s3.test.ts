import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample } from './run.test-helper.ts';

// BT126: every ESP32-S3 example runs 2 s of simulated time in Node (the S3's real ROM, a direct
// boot) and does what its card says.

const brightness = (r: ExampleRun, part: string): number => (r.visual(part)?.brightness as number | undefined) ?? 0;

export const ESP32S3_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'esp32s3-rgb-blink'(r) {
    r.runTo(2000);
    const colors = new Set(r.history('s3').map(({ visual }) => ((visual.pixels as number[] | undefined) ?? [0])[0]));
    for (const color of [0xff0000, 0x00ff00, 0x0000ff, 0x404040]) expect(colors).toContain(color);
  },
  'esp32s3-serial-hello'(r) {
    r.runTo(2000);
    expect(r.serial('s3')).toContain('hello from esp32s3');
    expect(r.serial('s3')).toContain('tick 1');
  },
  'esp32s3-pot-led'(r) {
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
  'esp32s3-oled-clock'(r) {
    r.runTo(2000);
    expect(r.serial('s3')).toContain('2026-01-01 00:00:01');
    expect(((r.visual('oled')?.fb ?? []) as number[]).some((v) => v !== 0)).toBe(true);
  },
};

describe('every ESP32-S3 example runs as described (BT126)', () => {
  const withS3 = EXAMPLES.filter((e) => Object.values(e.boards).some((b) => 'firmware' in b && b.firmware.startsWith('esp32s3/')));
  it('has a check for each', () => {
    expect(withS3.length).toBe(4);
    expect(withS3.map((e) => e.id).filter((id) => ESP32S3_CHECKS[id] === undefined)).toEqual([]);
  });
  for (const example of withS3) {
    it(
      example.id,
      () => {
        const check = ESP32S3_CHECKS[example.id];
        if (check === undefined) throw new Error(`no check for ${example.id}`);
        check(runExample(example));
      },
      60_000,
    );
  }
});
