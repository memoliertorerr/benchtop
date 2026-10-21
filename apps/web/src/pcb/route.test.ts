import { describe, expect, it } from 'vitest';
import { backUp, bend, extend, finishRoute, snapPoint, startRoute, switchLayer } from './route.ts';

describe('the trace tool (BT59)', () => {
  it('bends: straight along the longer axis, then 45°', () => {
    expect(bend({ x: 0, y: 0 }, { x: 10, y: 3 })).toEqual([{ x: 7, y: 0 }, { x: 10, y: 3 }]);
    expect(bend({ x: 0, y: 0 }, { x: -2, y: -8 })).toEqual([{ x: 0, y: -6 }, { x: -2, y: -8 }]);
    expect(bend({ x: 0, y: 0 }, { x: 5, y: 0 })).toEqual([{ x: 5, y: 0 }]);
    expect(bend({ x: 0, y: 0 }, { x: 4, y: 4 })).toEqual([{ x: 4, y: 4 }]);
    expect(bend({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it('snaps to the 25 mil grid', () => {
    expect(snapPoint({ x: 1.3, y: -0.4 })).toEqual({ x: 1.27, y: -0.635 });
    expect(snapPoint({ x: 0.2, y: -0.3 })).toEqual({ x: 0, y: 0 });
  });

  it('routes across a layer switch: a via where it switched, a trace on each layer', () => {
    let r = startRoute({ x: 0, y: 0 }, 'F', 0.4);
    r = extend(r, { x: 10, y: 3 });
    r = extend(r, { x: 10, y: 3 }); // a second click on the same point adds nothing
    r = switchLayer(r, { drill: 0.4, diameter: 0.8 });
    expect(r.layer).toBe('B');
    r = extend(r, { x: 10, y: 20 });
    r = extend(r, { x: 14, y: 22 });
    r = backUp(r);
    r = extend(r, { x: 12, y: 20 });
    const done = finishRoute(r);
    expect(done.vias).toEqual([{ x: 10, y: 3, drill: 0.4, diameter: 0.8 }]);
    expect(done.traces).toEqual([
      { layer: 'F', width: 0.4, points: [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 10, y: 3 }] },
      { layer: 'B', width: 0.4, points: [{ x: 10, y: 3 }, { x: 10, y: 20 }, { x: 12, y: 20 }] },
    ]);
    // A switch right at the start leaves no empty trace behind.
    expect(finishRoute(switchLayer(startRoute({ x: 1, y: 1 }, 'F', 0.4), { drill: 0.4, diameter: 0.8 })).traces).toEqual([]);
  });
});
