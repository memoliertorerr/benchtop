/**
 * HX711 24-bit load-cell ADC (BT52; Avia Semiconductor HX711 datasheet). DOUT (pin DT) is high
 * while no conversion is waiting and goes low when one is ready — 10 per second (RATE low on the
 * common modules). Each PD_SCK (pin SCK) rising edge then shifts out the next bit, MSB first, 24
 * bits of two's complement; the 25th pulse sends DOUT high, and the pulse count picks the next
 * conversion's input: 25 → channel A, gain 128; 26 → channel B, gain 32; 27 → channel A, gain 64.
 * PD_SCK held high over 60 µs powers it down (DOUT high, no conversions); low again powers it up
 * at channel A × 128, the first conversion 100 ms later.
 *
 * The load cell on channel A reads `offset + weight · countsPerGram` counts at gain 128 (props;
 * gain 64 halves it), saturating at the 24-bit limits; channel B has nothing connected and reads
 * 0. The weight in grams is prop `weight` and input `{ kind: 'value', value }`. Prop `type`
 * ('50kg', '5kg', 'gauge') only picks the element's drawing. Pins from @wokwi/elements 1.9.2
 * hx711-element.
 */

import { type PartContext, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

const PX = 25.4 / 96;
const MS = 1_000_000;
/** One conversion every 100 ms (10 SPS). */
export const HX711_PERIOD_NS = 100 * MS;
/** PD_SCK high this long powers the chip down. */
const POWER_DOWN_NS = 60_000;
const MAX = 0x7fffff;
const MIN = -0x800000;

/** [name, x px, y px] from the element's pinInfo. */
const PIN_INFO: readonly (readonly [string, number, number])[] = [
  ['VCC', 7, 55],
  ['DT', 7, 36.3],
  ['SCK', 7, 46.2],
  ['GND', 7, 26.5],
];
export const HX711_PIN_PX = PIN_INFO;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export const hx711 = definePart({
  type: 'hx711',
  title: 'Load cell + HX711',
  category: 'sensors',
  size: { w: 58, h: 43 },
  pins: PIN_INFO.map(([name, x, y]) => ({
    name,
    x: Math.round(x * PX * 1000) / 1000,
    y: Math.round(y * PX * 1000) / 1000,
    role: name === 'VCC' ? ('power' as const) : name === 'GND' ? ('ground' as const) : ('digital' as const),
  })),
  defaults: { weight: 0, countsPerGram: 100, offset: 0, type: '50kg' },
  createModel(ctx: PartContext, props) {
    const dout = ctx.pin('DT');
    const sck = ctx.pin('SCK');
    const countsPerGram = num(props.countsPerGram, 100);
    const offset = num(props.offset, 0);
    let weight = num(props.weight, 0);
    /** Pulses after the last 24-bit word: 25 → A×128, 26 → B×32, 27 → A×64. */
    let gainPulses = 25;
    let data = 0;
    let ready = false;
    /** PD_SCK rising edges since DOUT went low (0 = not reading). */
    let pulses = 0;
    let poweredDown = false;
    let sckHigh = false;
    /** When PD_SCK last went high: power-down needs it high since then, not just high again. */
    let riseAt = -1;
    let generation = 0;

    const reading = (): number => {
      if (gainPulses === 26) return 0; // channel B: nothing connected
      const counts = Math.round(offset + weight * countsPerGram) / (gainPulses === 27 ? 2 : 1);
      return Math.max(MIN, Math.min(MAX, Math.round(counts)));
    };

    const convert = (): void => {
      const gen = generation;
      ctx.schedule(HX711_PERIOD_NS, () => {
        if (gen !== generation || poweredDown) return;
        // A conversion finishing mid-read waits: the word being shifted out stays.
        if (pulses === 0 || pulses >= 25) {
          data = reading() & 0xffffff;
          ready = true;
          pulses = 0;
          dout.drive(0, Strength.strong);
        }
        convert();
      });
    };

    const powerUp = (): void => {
      generation++;
      poweredDown = false;
      gainPulses = 25;
      ready = false;
      pulses = 0;
      dout.drive(1, Strength.strong);
      convert();
    };

    sck.onChange((state) => {
      const high = state.level === 1;
      if (high === sckHigh) return;
      sckHigh = high;
      if (!high) {
        if (poweredDown) powerUp();
        return;
      }
      // Rising edge: the next bit, or after 24 the gain pulses.
      const gen = generation;
      const at = ctx.now();
      riseAt = at;
      ctx.schedule(POWER_DOWN_NS, () => {
        if (gen !== generation || !sckHigh || riseAt !== at || poweredDown) return;
        generation++;
        poweredDown = true;
        ready = false;
        dout.drive(1, Strength.strong);
      });
      if (!ready && pulses === 0) return;
      pulses++;
      if (pulses <= 24) dout.drive(((data >> (24 - pulses)) & 1) as 0 | 1, Strength.strong);
      else {
        if (pulses === 25) {
          ready = false;
          dout.drive(1, Strength.strong);
        }
        if (pulses <= 27) gainPulses = pulses;
      }
    });

    powerUp();
    return {
      input(event) {
        if (event.kind === 'value' && Number.isFinite(event.value)) {
          weight = event.value;
          ctx.invalidate();
        }
      },
      visual: () => ({ weight }),
      reset() {
        weight = num(props.weight, 0);
        sckHigh = sck.read().level === 1;
        powerUp();
        ctx.invalidate();
      },
    };
  },
});
