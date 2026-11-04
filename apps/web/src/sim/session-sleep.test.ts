import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../../packages/esp32/src/test-support/rom.test-helper.ts';
import type { FromSim } from './protocol.ts';
import { SimSession } from './session.ts';

// BT123: the worker's frames say which boards sleep and what wakes them (the board view's badge).

describe('SimSession sleep (BT123)', () => {
  it('frames carry a sleeping ESP32 — deep, the timer\'s wake time, its wake pin — and drop it when it wakes', () => {
    let wall = 0;
    let pending: (() => void) | null = null;
    const frames: Extract<FromSim, { type: 'frame' }>[] = [];
    const session = new SimSession({
      post: (message) => {
        if (message.type === 'frame') frames.push(structuredClone(message));
      },
      now: () => wall,
      schedule: (fn) => (pending = fn),
      esp32Rom: () => loadCachedRom(),
    });
    const advance = (ms: number): void => {
      const end = wall + ms;
      while (wall < end) {
        wall = Math.min(end, wall + 4);
        const fn = pending;
        pending = null;
        fn?.();
      }
    };
    const doc = JSON.parse(readFixtureText('fixtures/projects/esp32-deep-sleep.json')) as ProjectDoc;
    session.handle({ type: 'load', doc, firmware: { esp: { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32/deep-sleep-counter.bin'), partitions: readFixture('fixtures/firmware/esp32/deep-sleep-counter.partitions.bin') } } });
    session.handle({ type: 'run', speed: 1 });
    advance(200);
    expect(frames.at(-1)?.stats.sleep).toBeUndefined(); // booting
    advance(1000);
    const asleep = frames.at(-1)?.stats.sleep?.esp;
    expect(asleep).toMatchObject({ deep: true, pins: ['GPIO4 low'] });
    expect((asleep?.wakeAt ?? 0) / 1e9).toBeGreaterThan(5);
    expect((asleep?.wakeAt ?? 0) / 1e9).toBeLessThan(6);
    session.handle({ type: 'input', part: 'btn1', event: { kind: 'press' } });
    advance(100);
    expect(frames.at(-1)?.stats.sleep).toBeUndefined();
  }, 60_000);
});
