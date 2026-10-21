import type { PartInstance, ProjectDoc } from '@benchtop/core';
import { benchEnvParts } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { PcbBoard } from './board.ts';
import { DEFAULT_RULES, type PcbDoc, type PcbTrace } from './doc.ts';
import { drc } from './drc.ts';

// BT57: DRC's cost on a dense board — 500 footprints, 5,000 track segments (a wall-clock
// budget: vitest.config.ts's QUIET group).

describe('DRC cost', () => {
  it('checks 500 footprints and 5,000 segments in under 100 ms', () => {
    const parts: PartInstance[] = [];
    const pcb: PcbDoc = { format: 1, name: 'dense', outline: [], footprints: [], traces: [], vias: [], rules: { ...DEFAULT_RULES } };
    for (let i = 0; i < 500; i++) {
      const col = i % 20;
      const row = Math.floor(i / 20);
      parts.push({ id: `r${i}`, type: 'resistor', x: col * 30, y: row * 20, rotation: 0, props: {} });
      pcb.footprints.push({ part: `r${i}`, ref: `R${i + 1}`, x: 10 + col * 15, y: 10 + row * 8, rotation: 0 });
      // Ten segments per footprint, wandering beside it.
      const points = Array.from({ length: 11 }, (_, k) => ({ x: 4 + col * 15 + k * 1.2, y: 13.5 + row * 8 + (k % 2) * 0.6 }));
      pcb.traces.push({ id: `t${i}`, layer: i % 2 === 0 ? 'F' : 'B', width: 0.25, points } satisfies PcbTrace);
    }
    pcb.outline = [
      { x: 0, y: 0 },
      { x: 320, y: 0 },
      { x: 320, y: 220 },
      { x: 0, y: 220 },
    ];
    const project: ProjectDoc = { format: 1, name: 'dense', parts, wires: [], firmware: {} };
    const board = new PcbBoard(project, pcb, benchEnvParts);
    drc(board); // warm up
    const start = performance.now();
    const result = drc(new PcbBoard(project, pcb, benchEnvParts));
    const ms = performance.now() - start;
    console.info(`DRC: ${ms.toFixed(1)} ms for 500 footprints, 5,000 segments (${result.violations.length} listed)`);
    expect(ms).toBeLessThan(100);
  });
});
