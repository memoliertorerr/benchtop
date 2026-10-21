import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDoc } from '@benchtop/core';
import { benchEnvParts } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { PcbBoard } from '../board.ts';
import { copperItems } from '../connectivity.ts';
import { parsePcb } from '../doc.ts';
import { drc } from '../drc.ts';
import { shapeDistance } from '../geometry.ts';
import { bomCsv, csvField } from './bom.ts';
import { excellon, holes } from './excellon.ts';
import { fabricationFiles, fabricationZip, fileBase } from './fab.ts';
import { gerberFiles } from './gerber.ts';
import { covered, readExcellon, readGerber } from './gerber.test-helper.ts';
import { kicadNetlist, sx } from './kicad.ts';
import { crc32, zip } from './zip.ts';

// BT58: the fabrication exports of the committed blink board (fixtures/pcb/blink.pcb.json, routed
// by hand on fixtures/projects/blink-led.json), read back by our own Gerber and Excellon readers,
// and the text exports against golden files (UPDATE_GOLDEN=1 rewrites them).

function blinkBoard(): PcbBoard {
  const project = JSON.parse(readFixtureText('fixtures/projects/blink-led.json')) as ProjectDoc;
  const parsed = parsePcb(JSON.parse(readFixtureText('fixtures/pcb/blink.pcb.json')));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return new PcbBoard(project, parsed.doc, benchEnvParts);
}

describe('the fixture board', () => {
  it('passes DRC: routed, no shorts, clear of the edge', () => {
    expect(drc(blinkBoard())).toEqual({ violations: [], unrouted: 0 });
  });
});

describe('Gerber', () => {
  const board = blinkBoard();
  const files = Object.fromEntries(gerberFiles(board).map((f) => [f.suffix, readGerber(f.text)]));

  it('names each layer with X2 file attributes', () => {
    expect(Object.keys(files)).toEqual(['-F_Cu.gtl', '-B_Cu.gbl', '-F_Mask.gts', '-B_Mask.gbs', '-F_Silkscreen.gto', '-Edge_Cuts.gm1']);
    expect(files['-F_Cu.gtl'].attributes).toContain('TF.FileFunction,Copper,L1,Top');
    expect(files['-B_Cu.gbl'].attributes).toContain('TF.FileFunction,Copper,L2,Bot');
    expect(files['-F_Mask.gts'].attributes).toContain('TF.FilePolarity,Negative');
    expect(files['-Edge_Cuts.gm1'].attributes).toContain('TF.FileFunction,Profile,NP');
  });

  it('puts copper exactly where the board has it, on the right layer', () => {
    const items = copperItems(board);
    for (const item of items) {
      const s = item.shape;
      const points = s.k === 'cap' ? [{ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }, { x: s.x1, y: s.y1 }] : [{ x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 }];
      for (const p of points) {
        if (item.layer === null || item.layer === 'F') expect(covered(files['-F_Cu.gtl'], p.x, p.y), `${item.kind} ${item.index} on F`).toBe(true);
        if (item.layer === null || item.layer === 'B') expect(covered(files['-B_Cu.gbl'], p.x, p.y), `${item.kind} ${item.index} on B`).toBe(true);
      }
    }
    // Nowhere else: sample the board on a 1 mm grid, away from every item by 0.05 mm.
    const xs = board.pcb.outline.map((p) => p.x);
    const ys = board.pcb.outline.map((p) => p.y);
    let checked = 0;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
      for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1) {
        for (const layer of ['F', 'B'] as const) {
          const near = items.some((i) => (i.layer === null || i.layer === layer) && shapeDistance(i.shape, { k: 'cap', x1: x, y1: y, x2: x, y2: y, r: 0 }) < 0.05);
          if (near) continue;
          checked++;
          expect(covered(files[layer === 'F' ? '-F_Cu.gtl' : '-B_Cu.gbl'], x, y), `(${x}, ${y}) on ${layer}`).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('opens the mask over every pad, grown 0.05 mm, and tents the vias', () => {
    for (const p of board.pads) {
      expect(covered(files['-F_Mask.gts'], p.x + Math.min(p.w, p.h) / 2 + 0.04, p.y)).toBe(true);
      expect(covered(files['-B_Mask.gbs'], p.x, p.y)).toBe(true);
    }
    for (const v of board.pcb.vias) expect(covered(files['-F_Mask.gts'], v.x, v.y)).toBe(false);
  });

  it('draws the outline closed and the references on the silkscreen', () => {
    const outline = files['-Edge_Cuts.gm1'].paths;
    expect(outline).toHaveLength(1);
    const o = board.pcb.outline;
    expect(outline[0].map((p) => [Math.round(p.x * 1e3) / 1e3, Math.round(p.y * 1e3) / 1e3])).toEqual([...o, o[0]].map((p) => [p.x, p.y]));
    expect(files['-F_Silkscreen.gto'].primitives.length).toBeGreaterThan(30);
  });
});

describe('Excellon', () => {
  it('lists every plated hole once, by tool', () => {
    const board = blinkBoard();
    const read = readExcellon(excellon(board));
    const want = holes(board).map((h) => [Number(h.x.toFixed(4)), Number(h.y.toFixed(4)), h.d]);
    const key = (h: number[]): string => h.join(',');
    expect(read.map((h) => key([h.x, h.y, h.d])).sort()).toEqual(want.map(key).sort());
  });
});

describe('text exports and the bundle', () => {
  const update = process.env.UPDATE_GOLDEN === '1';
  const golden = (name: string, text: string): void => {
    const path = join(REPO_ROOT, 'fixtures', 'pcb', 'golden', name);
    if (update) {
      mkdirSync(join(REPO_ROOT, 'fixtures', 'pcb', 'golden'), { recursive: true });
      writeFileSync(path, text);
    }
    expect(text).toBe(readFileSync(path, 'utf8'));
  };

  it('match their golden files', () => {
    for (const f of fabricationFiles(blinkBoard())) golden(f.name.replace(/\//g, '__'), f.text);
  });

  it('quote CSV and s-expression strings', () => {
    expect([csvField('a,b'), csvField('say "hi"'), csvField('plain')]).toEqual(['"a,b"', '"say ""hi"""', 'plain']);
    expect(sx('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(bomCsv(blinkBoard()).split('\r\n')[0]).toBe('Reference,Value,Footprint,Quantity,Part');
    expect(kicadNetlist(blinkBoard())).toMatch(/^\(export \(version "E"\)/);
    expect(fileBase(' My board: v2 ')).toBe('My-board-v2');
  });

  it('zips byte-identically, with correct CRCs', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const a = fabricationZip(blinkBoard());
    const b = fabricationZip(blinkBoard());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    // The end record counts every file; the first local header names the first file.
    const view = new DataView(a.buffer, a.byteOffset, a.byteLength);
    const files = fabricationFiles(blinkBoard());
    expect(view.getUint32(a.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(a.length - 12, true)).toBe(files.length);
    expect(new TextDecoder().decode(a.subarray(30, 30 + view.getUint16(26, true)))).toBe(files[0].name);
    expect(zip([]).length).toBe(22);
  });
});
