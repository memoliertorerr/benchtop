import { describe, expect, it } from 'vitest';
import { Bench } from './bench.ts';
import type { PartDefinition, ProjectDoc } from '../contracts/index.ts';
import { FakeMcu, fakeBoard, makeBenchEnv } from '../testing.ts';
import { type TouchSensing, touchLoadOf, usesTouch } from './touch.ts';

// BT155: the bench's touch seam — an MCU with touch pins gets a source that sums the touch loads
// (a part model's `touchLoad`) on each pin's net; nothing else on a net adds anything.

/** A fake MCU with touch channels on T1 and T2. */
class TouchMcu extends FakeMcu implements TouchSensing {
  source: ((pin: string) => number) | null = null;
  touchPins(): readonly string[] {
    return ['T1', 'T2'];
  }
  setTouchSource(source: ((pin: string) => number) | null): void {
    this.source = source;
  }
}

/** A pad adding `pf` (prop) plus 10 while pressed. */
const pad: PartDefinition = {
  type: 'pad',
  title: 'Pad',
  category: 'input',
  size: { w: 5, h: 5 },
  pins: [{ name: 'PAD', x: 0, y: 0, role: 'passive' }],
  defaults: { pf: 2 },
  createModel(_ctx, props) {
    let pressed = false;
    return {
      touchLoad: { pf: () => Number(props.pf) + (pressed ? 10 : 0) },
      input(event) {
        if (event.kind === 'press') pressed = true;
        else if (event.kind === 'release') pressed = false;
      },
    };
  },
};
const plain: PartDefinition = { type: 'plain', title: 'Plain', category: 'input', size: { w: 5, h: 5 }, pins: [{ name: 'A', x: 0, y: 0, role: 'passive' }], defaults: {} };
const board = fakeBoard('touch-board', ['T1', 'T2', 'D1'], 'esp32s2');

function doc(parts: Record<string, string>, wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'touch',
    parts: Object.entries(parts).map(([id, type], i) => ({ id, type, x: i * 20, y: 0, rotation: 0, props: {} })),
    wires: wires.map(([a, b], i) => {
      const [ap, aPin] = a.split(':');
      const [bp, bPin] = b.split(':');
      return { id: `w${i}`, from: { part: ap, pin: aPin }, to: { part: bp, pin: bPin }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  } as ProjectDoc;
}

describe('the bench’s touch seam (BT155)', () => {
  it('finds touch MCUs and touch loads by duck typing', () => {
    expect(usesTouch(new TouchMcu({ pins: ['T1'] }))).toBe(true);
    expect(usesTouch(new FakeMcu({ pins: ['T1'] }))).toBe(false);
    expect(touchLoadOf({ touchLoad: { pf: () => 1 } })?.pf()).toBe(1);
    expect(touchLoadOf({ touchLoad: 3 })).toBeUndefined();
    expect(touchLoadOf(null)).toBeUndefined();
  });

  it('sums the pads on a touch pin’s net as they are now; other nets, other parts and unwired pins add nothing', () => {
    const mcu = new TouchMcu({ pins: ['T1', 'T2', 'D1'] });
    const bench = new Bench(
      doc({ b: 'touch-board', p1: 'pad', p2: 'pad', p3: 'pad', x: 'plain' }, [
        ['b:T1', 'p1:PAD'],
        ['p1:PAD', 'p2:PAD'],
        ['b:D1', 'p3:PAD'],
        ['b:T2', 'x:A'],
      ]),
      makeBenchEnv([board, pad, plain], () => mcu),
    );
    const source = mcu.source;
    if (source === null) throw new Error('no touch source');
    expect(source('T1')).toBe(4); // two pads
    expect(source('T2')).toBe(0); // a part without a touch load
    bench.input('p2', { kind: 'press' });
    expect(source('T1')).toBe(14);
    bench.input('p3', { kind: 'press' }); // on D1: not a touch pin's net
    expect(source('T1')).toBe(14);
    expect(source('D1')).toBe(0);
  });
});
