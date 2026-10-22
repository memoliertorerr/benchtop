/**
 * Linear regulators (BT84): OUT follows IN — `min(Vout, VIN − dropout)` above GND — at supply
 * strength, so what it powers sees a supply, as from a battery (sources.ts). Released while IN or
 * GND float or IN isn't above GND. Problems while running: `regulator-dropout` (a warning: IN
 * below Vout + dropout, OUT sags with it) and `regulator-overvoltage` (an error: IN above the
 * maximum rating). Datasheet figures (typical dropout at a moderate load):
 * - LM7805 (TO-220): 5 V, 2 V dropout, 35 V max in (TI LM7800 series).
 * - AMS1117-3.3 (a breakout board): 3.3 V, 1.1 V dropout at 800 mA, 15 V max in.
 * - MCP1700-3302 (TO-92): 3.3 V, 0.178 V dropout at 250 mA, 6 V max in — the low-dropout one a
 *   LiPo (3.7 V) can feed.
 * OUT is the first power pin listed: a part's logic supply (what its drives call a 1) comes from
 * its first power pin's net, and OUT's is what the regulator makes.
 */

import { type PartDefinition, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { FightWatch } from './fight.ts';

interface RegulatorSpec {
  type: string;
  title: string;
  /** What the datasheet calls it, for messages. */
  name: string;
  vout: number;
  dropout: number;
  maxIn: number;
  size: { w: number; h: number };
  /** Pin names and positions: input, ground, output. */
  pins: { in: [string, number, number]; gnd: [string, number, number]; out: [string, number, number] };
}

export interface RegulatorFigures {
  vout: number;
  dropout: number;
  maxIn: number;
}

/** Each regulator's figures (for tests and docs). */
export const REGULATORS: Record<string, RegulatorFigures> = {};

function regulator(spec: RegulatorSpec): PartDefinition {
  REGULATORS[spec.type] = { vout: spec.vout, dropout: spec.dropout, maxIn: spec.maxIn };
  const [inName, inX, inY] = spec.pins.in;
  const [gndName, gndX, gndY] = spec.pins.gnd;
  const [outName, outX, outY] = spec.pins.out;
  return definePart({
    type: spec.type,
    title: spec.title,
    category: 'power',
    size: spec.size,
    pins: [
      { name: outName, x: outX, y: outY, role: 'power' },
      { name: inName, x: inX, y: inY, role: 'power' },
      { name: gndName, x: gndX, y: gndY, role: 'ground' },
    ],
    defaults: {},
    createModel(ctx) {
      const input = ctx.pin(inName);
      const ground = ctx.pin(gndName);
      const output = ctx.pin(outName);
      const fight = new FightWatch(ctx, output, `Its ${outName} output`);
      let dropout = false;
      let over = false;
      let driving = false;
      const visual = { volts: 0, on: false };
      const report = (code: string, active: boolean, message: string): void => {
        ctx.report({ severity: code === 'regulator-overvoltage' ? 'error' : 'warning', code, message: active ? message : '', parts: [] });
      };
      const update = (): void => {
        const vin = input.read();
        const gnd = ground.read();
        const headroom = vin.volts - gnd.volts;
        const powered = vin.strength !== Strength.hiz && gnd.strength !== Strength.hiz && headroom > 0;
        const v = powered ? gnd.volts + Math.min(spec.vout, Math.max(0, headroom - spec.dropout)) : 0;
        if (powered) {
          if (!driving || Math.abs(v - fight.target) > 1e-9) {
            fight.target = v;
            driving = true;
            output.driveVolts(v, Strength.supply);
            fight.check();
          }
        } else if (driving) {
          driving = false;
          output.release();
        }
        const sag = powered && headroom < spec.vout + spec.dropout;
        if (sag !== dropout) {
          dropout = sag;
          report('regulator-dropout', sag, `IN is ${headroom.toFixed(2)} V above GND: the ${spec.name} needs ${(spec.vout + spec.dropout).toFixed(2)} V for ${spec.vout} V out, so OUT sags to ${(v - gnd.volts).toFixed(2)} V.`);
        }
        const high = powered && headroom > spec.maxIn;
        if (high !== over) {
          over = high;
          report('regulator-overvoltage', high, `IN is ${headroom.toFixed(2)} V above GND; the ${spec.name} is rated for ${spec.maxIn} V at most.`);
        }
        const shown = powered ? Math.round((v - gnd.volts) * 100) / 100 : 0;
        if (shown !== visual.volts || powered !== visual.on) {
          visual.volts = shown;
          visual.on = powered;
          ctx.invalidate();
        }
      };
      input.onChange(update);
      ground.onChange(update);
      update();
      return {
        visual: () => visual,
        reset() {
          update();
        },
      };
    },
  });
}

/** TO-220, seen from the front: the tab with its hole on top, IN / GND / OUT legs below. */
export const lm7805 = regulator({
  type: 'lm7805',
  title: 'LM7805 regulator (5 V)',
  name: 'LM7805',
  vout: 5,
  dropout: 2,
  maxIn: 35,
  size: { w: 10.16, h: 27 },
  pins: { in: ['IN', 2.54, 25.4], gnd: ['GND', 5.08, 25.4], out: ['OUT', 7.62, 25.4] },
});

/** A small blue AMS1117-3.3 breakout: VIN / GND / VOUT header along its lower edge. */
export const ams1117 = regulator({
  type: 'ams1117-3v3',
  title: 'AMS1117-3.3 regulator board',
  name: 'AMS1117-3.3',
  vout: 3.3,
  dropout: 1.1,
  maxIn: 15,
  size: { w: 12.7, h: 16.5 },
  pins: { in: ['VIN', 3.81, 14.6], gnd: ['GND', 6.35, 14.6], out: ['VOUT', 8.89, 14.6] },
});

/** TO-92, flat face forward: GND / VIN / VOUT (the MCP1700 datasheet's TO-92 order). */
export const mcp1700 = regulator({
  type: 'mcp1700-3v3',
  title: 'MCP1700-3.3 low-dropout regulator',
  name: 'MCP1700-3.3',
  vout: 3.3,
  dropout: 0.178,
  maxIn: 6,
  size: { w: 7.62, h: 14 },
  pins: { in: ['VIN', 3.81, 12.7], gnd: ['GND', 1.27, 12.7], out: ['VOUT', 6.35, 12.7] },
});

export const POWER_REGULATORS: readonly PartDefinition[] = [lm7805, ams1117, mcp1700];
