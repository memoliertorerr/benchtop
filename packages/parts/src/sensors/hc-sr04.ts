/**
 * HC-SR04 ultrasonic distance sensor. A TRIG high pulse ≥ 10 µs arms it (shorter pulses are
 * ignored); 200 µs after TRIG falls (the 8 × 25 µs burst) ECHO goes strong 1 for the round trip,
 * distance·2 / 343 m/s = 58.31 µs per cm, then back to 0. Beyond 400 cm, or with no object
 * (distance ≤ 0), the echo stays high for 38 ms. Triggers during an echo are ignored. Channel
 * `distance` (cm); prop `distance` is the initial value. A RunSplitter keeps MCU runs under
 * 150 µs so the echo starts exactly 200 µs after the trigger. Pins from @wokwi/elements 1.9.2
 * hc-sr04-element.
 */

import { NS_PER_US, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { readChannelInput } from '../shared/channel-input.ts';
import { RunSplitter } from '../shared/run-splitter.ts';

export const ECHO_NS_PER_CM = (2 / 343) * 1e7; // 58,309 ns
export const NO_ECHO_NS = 38_000 * NS_PER_US;
const TRIGGER_MIN_NS = 10 * NS_PER_US;
const BURST_NS = 200 * NS_PER_US;
const SPLIT_NS = 150 * NS_PER_US;

/** How long ECHO stays high for an object at `cm`. */
export function echoNs(cm: number): number {
  return cm > 0 && cm <= 400 ? cm * ECHO_NS_PER_CM : NO_ECHO_NS;
}

export const hcSr04 = definePart({
  type: 'hc-sr04',
  title: 'Ultrasonic distance (HC-SR04)',
  category: 'sensors',
  size: { w: 45, h: 25 },
  pins: [
    { name: 'VCC', x: 18.865, y: 25.003, role: 'power' },
    { name: 'TRIG', x: 21.511, y: 25.003, role: 'digital' },
    { name: 'ECHO', x: 24.156, y: 25.003, role: 'digital' },
    { name: 'GND', x: 26.802, y: 25.003, role: 'ground' },
  ],
  defaults: { distance: 100 },
  createModel(ctx, props) {
    const trig = ctx.pin('TRIG');
    const echo = ctx.pin('ECHO');
    const splitter = new RunSplitter(ctx);
    let distance = props.distance;
    let riseAt = -1;
    let busy = false;
    const end = (): void => {
      echo.drive(0, Strength.strong);
      busy = false;
    };
    const start = (): void => {
      echo.drive(1, Strength.strong);
      ctx.schedule(echoNs(distance), end);
    };
    trig.onChange((state) => {
      const now = ctx.now();
      if (state.level === 1) {
        riseAt = now;
        return;
      }
      if (riseAt < 0) return;
      const width = now - riseAt;
      riseAt = -1;
      if (busy || width < TRIGGER_MIN_NS) return;
      busy = true;
      ctx.schedule(BURST_NS, start);
    });
    echo.drive(0, Strength.strong);
    splitter.arm(SPLIT_NS);
    return {
      input(event) {
        const channel = readChannelInput(event);
        if (channel?.channel === 'distance') distance = channel.value;
        else if (event.kind === 'value') distance = event.value;
        else return;
        ctx.invalidate();
      },
      visual: () => ({ distance }),
      reset() {
        distance = props.distance;
        riseAt = -1;
        busy = false;
        echo.drive(0, Strength.strong);
        splitter.reset();
        splitter.arm(SPLIT_NS);
        ctx.invalidate();
      },
    };
  },
});
