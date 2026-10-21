import { describe, expect, it } from 'vitest';
import { fqbnOf } from './fqbn.ts';

describe('fqbnOf (BT45: per board, not per MCU)', () => {
  it('gives each board its own FQBN, and none to parts that are not boards', () => {
    expect(fqbnOf('arduino-uno')).toBe('arduino:avr:uno');
    expect(fqbnOf('arduino-nano')).toBe('arduino:avr:nano');
    expect(fqbnOf('arduino-mega')).toBe('arduino:avr:mega');
    expect(fqbnOf('esp32-devkit-v1')).toBe('esp32:esp32:esp32');
    expect(fqbnOf('led')).toBeUndefined();
    expect(fqbnOf('no-such-part')).toBeUndefined();
  });
});
