import { describe, expect, it } from 'vitest';
import { ALL_EXAMPLES, EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample } from './run.test-helper.ts';

// BT112: every Raspberry Pi Pico W example (BT114: and Pico 2 W) runs in Node with its symbols (the
// CYW43 answered at its driver's API, as the app does) and does what its card says. They join about
// 2 s into a run (lwIP's DHCP retry after the association), later than an ESP32.

const ledOn = (r: ExampleRun, board = 'picow'): boolean => ((r.visual(board)?.led as number | undefined) ?? 0) > 0.3;

export const PICOW_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'picow-wifi-webserver'(r) {
    r.runTo(2600);
    expect(r.serial('picow')).toContain('server at 192.168.4.2\n');
    expect(ledOn(r)).toBe(false);
    r.input('on', { kind: 'press' });
    r.runTo(2700);
    expect(r.visual('on')).toMatchObject({ status: '200', body: 'led on', sent: 1 });
    expect(ledOn(r)).toBe(true);
    r.input('off', { kind: 'press' });
    r.runTo(2800);
    expect(r.visual('off')).toMatchObject({ status: '200', body: 'led off' });
    expect(ledOn(r)).toBe(false);
    expect(r.serial('picow')).toContain('GET /led on\nGET /led off\n');
    expect(r.visual('ap')).toMatchObject({ stations: 1 });
  },
  'pico2w-wifi-webserver'(r) {
    r.runTo(2600);
    expect(r.serial('pico2w')).toContain('server at 192.168.4.2\n');
    r.input('on', { kind: 'press' });
    r.runTo(2700);
    expect(r.visual('on')).toMatchObject({ status: '200', body: 'led on', sent: 1 });
    expect(ledOn(r, 'pico2w')).toBe(true);
    r.input('off', { kind: 'press' });
    r.runTo(2800);
    expect(ledOn(r, 'pico2w')).toBe(false);
  },
  'picow-wifi-http'(r) {
    r.runTo(3000);
    expect(r.serial('picow')).toContain('GET 200 {"hello":"world","count":1}\n');
    expect(r.serial('picow')).toContain('POST 200 ping\n');
    expect(r.visual('api')).toMatchObject({ requests: 2 });
  },
};

describe('every Raspberry Pi Pico W and Pico 2 W example runs as described (BT112, BT114)', () => {
  const withPicoW = ALL_EXAMPLES.filter((e) => Object.values(e.boards).some((b) => 'firmware' in b && /^pico2?w\//.test(b.firmware)));
  it('has a check for each', () => {
    expect(withPicoW.map((e) => e.id).sort()).toEqual(Object.keys(PICOW_CHECKS).sort());
  });
  for (const example of withPicoW) {
    // Skipped where the firmware is withheld (the published repository; THIRD_PARTY_NOTICES.md); examples.test.ts checks that's the only reason.
    it.skipIf(!EXAMPLES.includes(example))(example.id, () => {
      const run = runExample(example);
      PICOW_CHECKS[example.id](run);
      expect(run.bench.problems().filter((p) => p.severity === 'error')).toEqual([]);
    }, 60_000);
  }
});
