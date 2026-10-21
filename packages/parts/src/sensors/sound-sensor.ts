/**
 * Sound sensor modules (small and big; AOUT/GND/VCC/DOUT). Decided: AOUT = V·(0.5 + 0.45·level)
 * — a DC envelope, no audio waveform; DOUT is a strong 1 while level ≥ `threshold` (prop 0.5),
 * else a strong 0. Input { kind: 'value', value: level 0..1 }; press = a clap: level 1 for
 * 100 ms, then back to the level before. Pins from @wokwi/elements 1.9.2
 * small-sound-sensor-element / big-sound-sensor-element (same pins).
 */

import { NS_PER_MS, type PartContext, type PartInput, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { supplyOutput } from '../shared/supply.ts';
import { soundVolts } from '../shared/transfer.ts';

export const CLAP_MS = 100;

type SoundProps = { level: number; threshold: number };

function soundModel(ctx: PartContext, props: SoundProps) {
  const dout = ctx.pin('DOUT');
  let level = Math.min(1, Math.max(0, props.level));
  let clapping = false;
  let timer = -1;
  const shown = (): number => (clapping ? 1 : level);
  const apply = supplyOutput(ctx, 'VCC', 'GND', 'AOUT', (low, high) => soundVolts(low, high, shown()));
  const digital = (): void => dout.drive(shown() >= props.threshold ? 1 : 0, Strength.strong);
  const update = (): void => {
    apply();
    digital();
    ctx.invalidate();
  };
  const endClap = (): void => {
    timer = -1;
    clapping = false;
    update();
  };
  digital();
  return {
    input(event: PartInput) {
      if (event.kind === 'value') {
        level = Math.min(1, Math.max(0, event.value));
        update();
      } else if (event.kind === 'press') {
        if (timer >= 0) ctx.cancel(timer);
        clapping = true;
        timer = ctx.schedule(CLAP_MS * NS_PER_MS, endClap);
        update();
      }
    },
    visual: () => ({ level: shown(), ledSignal: shown() >= props.threshold }),
    reset() {
      level = Math.min(1, Math.max(0, props.level));
      clapping = false;
      timer = -1;
      update();
    },
  };
}

const pins = [
  { name: 'AOUT', x: 0, y: 2.91, role: 'analog' },
  { name: 'GND', x: 0, y: 5.424, role: 'ground' },
  { name: 'VCC', x: 0, y: 8.07, role: 'power' },
  { name: 'DOUT', x: 0, y: 10.716, role: 'digital' },
] as const;

export const smallSoundSensor = definePart({
  type: 'small-sound-sensor',
  title: 'Sound sensor (small)',
  category: 'sensors',
  size: { w: 35.211, h: 13.346 },
  pins: [...pins],
  defaults: { level: 0, threshold: 0.5 },
  createModel: soundModel,
});

export const bigSoundSensor = definePart({
  type: 'big-sound-sensor',
  title: 'Sound sensor (big)',
  category: 'sensors',
  size: { w: 37.056, h: 13.346 },
  pins: [...pins],
  defaults: { level: 0, threshold: 0.5 },
  createModel: soundModel,
});
