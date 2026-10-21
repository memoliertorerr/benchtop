import { describe, expect, it } from 'vitest';
import { channelInput, readChannelInput } from './channel-input.ts';
import { flameVolts, joystickVolts, LDR_MAX_OHMS, ldrModuleVolts, ldrOhms, mq2Ratio, mq2Volts, ntcModuleVolts, ntcOhms, potVolts, soundVolts } from './transfer.ts';

/** What avr8js's 10-bit ADC reads for `volts` against a 5 V reference. */
const adc = (volts: number): number => Math.min(1023, Math.floor((volts / 5) * 1024));

describe('transfer functions', () => {
  it('pots and joysticks are ratiometric between GND and VCC', () => {
    expect(potVolts(0, 5, 0.25)).toBe(1.25);
    expect(potVolts(1, 5, 0.5)).toBe(3);
    expect(potVolts(0, 5, 2)).toBe(5);
    expect(joystickVolts(0, 5, 1)).toBe(5);
    expect(joystickVolts(0, 5, 0)).toBe(2.5);
    expect(joystickVolts(0, 5, -1)).toBe(0);
    expect(adc(joystickVolts(0, 5, 0))).toBe(512);
  });

  it('LDR: rl10·(lux/10)^−gamma, 1 MΩ cap; module AO falls with light', () => {
    expect(ldrOhms(10, 20_000, 0.7)).toBeCloseTo(20_000, 6);
    expect(ldrOhms(100, 20_000, 0.7)).toBeCloseTo(3990.5, 0);
    expect(ldrOhms(0, 20_000, 0.7)).toBe(LDR_MAX_OHMS);
    expect(ldrOhms(0.001, 20_000, 0.7)).toBe(LDR_MAX_OHMS);
    expect(adc(ldrModuleVolts(0, 5, 100, 20_000, 0.7))).toBe(292);
    expect(adc(ldrModuleVolts(0, 5, 10, 20_000, 0.7))).toBe(682);
    expect(ldrModuleVolts(0, 5, 1000, 20_000, 0.7)).toBeLessThan(ldrModuleVolts(0, 5, 100, 20_000, 0.7));
  });

  it('NTC: β model, 10 kΩ at 25 °C; matches the common sketch formula', () => {
    expect(ntcOhms(25, 10_000, 3950)).toBeCloseTo(10_000, 6);
    expect(ntcOhms(50, 10_000, 3950)).toBeCloseTo(3588, 0);
    expect(adc(ntcModuleVolts(0, 5, 25, 10_000, 3950))).toBe(512);
    const a = adc(ntcModuleVolts(0, 5, 50, 10_000, 3950));
    expect(a).toBe(270);
    const celsius = 1 / (Math.log(1 / (1023 / a - 1)) / 3950 + 1 / 298.15) - 273.15;
    expect(celsius).toBeCloseTo(50, 0);
  });

  it('sound: V·(0.5 + 0.45·level)', () => {
    expect(soundVolts(0, 5, 0)).toBe(2.5);
    expect(soundVolts(0, 5, 1)).toBeCloseTo(4.75, 9);
    expect(soundVolts(0, 5, -3)).toBe(2.5);
  });
});

describe('channel inputs', () => {
  it('round-trips a channel and value', () => {
    expect(channelInput('x', -0.5)).toEqual({ kind: 'key', key: 'set:x=-0.5', down: true });
    expect(readChannelInput(channelInput('y', 1))).toEqual({ channel: 'y', value: 1 });
    expect(readChannelInput(channelInput('lux-2', 1e-3))).toEqual({ channel: 'lux-2', value: 0.001 });
  });

  it('ignores everything else', () => {
    expect(readChannelInput({ kind: 'press' })).toBeNull();
    expect(readChannelInput({ kind: 'value', value: 1 })).toBeNull();
    expect(readChannelInput({ kind: 'key', key: 'cw', down: true })).toBeNull();
    expect(readChannelInput({ kind: 'key', key: 'set:x=1', down: false })).toBeNull();
    expect(readChannelInput({ kind: 'key', key: 'set:x=abc', down: true })).toBeNull();
    expect(readChannelInput({ kind: 'key', key: 'set:x=Infinity', down: true })).toBeNull();
    expect(readChannelInput({ kind: 'key', key: 'set:X=1', down: true })).toBeNull();
  });
});

describe('flame and MQ-2 modules (BT53)', () => {
  it('flame: no infrared reads VCC, full infrared 10 % of it, linear between', () => {
    const v = [flameVolts(0, 5, 0), flameVolts(0, 5, 0.5), flameVolts(0, 5, 1), flameVolts(0, 5, 2)];
    [5, 2.75, 0.5, 0.5].forEach((expected, i) => expect(v[i]).toBeCloseTo(expected, 9));
  });

  it('MQ-2: Rs/R0 is 9.8 in clean air and falls on the datasheet slope; AO = 10 kΩ under Rs', () => {
    expect(mq2Ratio(0)).toBe(9.8);
    expect(mq2Ratio(200)).toBeCloseTo(1.6, 1);
    expect(mq2Ratio(10_000) / mq2Ratio(1000)).toBeCloseTo(10 ** -0.47, 6);
    expect(mq2Volts(0, 5, 0)).toBeCloseTo((5 * 10) / (98 + 10), 6); // ≈ 0.46 V
    expect(mq2Volts(0, 5, 1000)).toBeGreaterThan(2.5); // past a half-supply threshold
    expect(mq2Volts(0, 5, 200)).toBeLessThan(2.5);
  });
});
