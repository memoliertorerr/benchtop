/**
 * An output that follows a module's own supply: `volts(low, high)` from the GND and VCC pins'
 * volts, driven as an ideal strong source and recomputed whenever either supply net changes.
 * Released while both supply pins float (an unpowered module drives nothing).
 */

import { type PartContext, Strength } from '@benchtop/core';

export function supplyOutput(ctx: PartContext, vcc: string, gnd: string, out: string, volts: (low: number, high: number) => number): () => void {
  const high = ctx.pin(vcc);
  const low = ctx.pin(gnd);
  const output = ctx.pin(out);
  const apply = (): void => {
    const h = high.read();
    const l = low.read();
    if (h.strength === Strength.hiz && l.strength === Strength.hiz) output.release();
    else output.driveVolts(volts(l.volts, h.volts), Strength.strong);
  };
  high.onChange(apply);
  low.onChange(apply);
  return apply;
}
