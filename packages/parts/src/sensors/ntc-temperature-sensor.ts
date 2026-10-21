/**
 * NTC temperature module: 10 kΩ at 25 °C, β 3950 (prop `beta`), with 10 kΩ VCC→OUT and the NTC
 * OUT→GND as resistive links (the analog layer solves OUT), which matches the common sketch formula
 * 1 / (ln(1 / (1023 / a − 1)) / β + 1 / 298.15) − 273.15. Input { kind: 'value', value: °C }.
 * Pins from @wokwi/elements 1.9.2 ntc-temperature-sensor-element.
 */

import { definePart } from '../define.ts';
import { Divider } from '../shared/divider.ts';
import { MODULE_DIVIDER_OHMS, ntcOhms } from '../shared/transfer.ts';

export const NTC_R25_OHMS = 10_000;

export const ntcTemperatureSensor = definePart({
  type: 'ntc-temperature-sensor',
  title: 'NTC temperature sensor',
  category: 'sensors',
  size: { w: 35.826, h: 19 },
  pins: [
    { name: 'GND', x: 35.719, y: 6.932, role: 'ground' },
    { name: 'VCC', x: 35.719, y: 9.472, role: 'power' },
    { name: 'OUT', x: 35.719, y: 12.039, role: 'analog' },
  ],
  links: [
    { id: 'pullup', a: 'VCC', b: 'OUT', kind: 'resistive', ohms: MODULE_DIVIDER_OHMS },
    { id: 'ntc', a: 'OUT', b: 'GND', kind: 'resistive', ohms: NTC_R25_OHMS },
  ],
  defaults: { temperature: 25, beta: 3950 },
  createModel(ctx, props) {
    let celsius = props.temperature;
    const divider = new Divider(ctx, 'pullup', 'ntc');
    const apply = (): void => divider.set(MODULE_DIVIDER_OHMS, ntcOhms(celsius, NTC_R25_OHMS, props.beta));
    apply();
    return {
      input(event) {
        if (event.kind !== 'value' || !Number.isFinite(event.value)) return;
        celsius = Math.min(150, Math.max(-55, event.value));
        apply();
        ctx.invalidate();
      },
      visual: () => ({ temperature: celsius }),
      reset() {
        celsius = props.temperature;
        apply();
        ctx.invalidate();
      },
    };
  },
});
