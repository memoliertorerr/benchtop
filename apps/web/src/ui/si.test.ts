import { describe, expect, it } from 'vitest';
import { formatSi, parseSi } from './si.ts';

describe('SI values in the Inspector (BT167)', () => {
  it('shows ohms and farads with a prefix and three significant digits', () => {
    expect(formatSi(220, 'Ω')).toBe('220 Ω');
    expect(formatSi(4700, 'Ω')).toBe('4.7 kΩ');
    expect(formatSi(1e6, 'Ω')).toBe('1 MΩ');
    expect(formatSi(100e-9, 'F')).toBe('100 nF');
    expect(formatSi(10e-6, 'F')).toBe('10 µF');
    expect(formatSi(2.2e-11, 'F')).toBe('22 pF');
    expect(formatSi(4.7e-3, 'F')).toBe('4.7 mF');
    expect(formatSi(0, 'F')).toBe('0 F');
  });

  it('reads what people type: prefixes, units, the prefix as the point, plain and exponent numbers', () => {
    const near = (a: number, b: number): void => expect(Math.abs(a - b) / b).toBeLessThan(1e-12);
    near(parseSi('4.7k', 'Ω'), 4700);
    near(parseSi('4k7', 'Ω'), 4700);
    near(parseSi('4R7', 'Ω'), 4.7);
    near(parseSi('1M', 'Ω'), 1e6);
    near(parseSi('220 Ω', 'Ω'), 220);
    near(parseSi('10 kohm', 'Ω'), 10_000);
    near(parseSi('100n', 'F'), 100e-9);
    near(parseSi('100nF', 'F'), 100e-9);
    near(parseSi('0.1u', 'F'), 100e-9);
    near(parseSi('10 µF', 'F'), 10e-6);
    near(parseSi('2u2', 'F'), 2.2e-6);
    near(parseSi('1e-7', 'F'), 1e-7);
    near(parseSi('22p', 'F'), 22e-12);
    expect(parseSi('4.7k7', 'Ω')).toBeNaN();
    expect(parseSi('4R7', 'F')).toBeNaN();
    expect(parseSi('abc', 'F')).toBeNaN();
    expect(parseSi('', 'F')).toBeNaN();
  });
});
