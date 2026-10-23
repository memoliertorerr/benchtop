import { describe, expect, it } from 'vitest';
import { simLoaded } from '../sim/host.ts';
import { serialBuffer, serialVersion } from './serial-state.ts';

describe('serial output across loads (BT96)', () => {
  it('a full load empties every board\'s output; staying loaded keeps it', () => {
    simLoaded.value = true;
    serialBuffer('uno').append(new TextEncoder().encode('hello\n'), 1_000);
    serialBuffer('esp').append(new TextEncoder().encode('tick\n'), 2_000);
    expect(serialBuffer('uno').lines.map((l) => l.text)).toEqual(['hello']);
    const before = serialVersion.peek();
    // Another example opens: the controller's sim.load drops the loaded flag first.
    simLoaded.value = false;
    expect(serialBuffer('uno').lines).toEqual([]);
    expect(serialBuffer('esp').lines).toEqual([]);
    expect(serialVersion.peek()).toBeGreaterThan(before);
    simLoaded.value = true;
    serialBuffer('uno').append(new TextEncoder().encode('fresh\n'), 500);
    expect(serialBuffer('uno').lines.map((l) => l.text)).toEqual(['fresh']);
  });
});
