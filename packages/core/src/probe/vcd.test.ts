import { describe, expect, it } from 'vitest';
import { vcdId, vcdName, writeVcd } from './vcd.ts';

/** A minimal VCD reader: variables by id, then every (time, id, value) change. */
function readVcd(text: string) {
  const vars = new Map<string, string>();
  const changes: [number, string, string][] = [];
  let timescale = '';
  let t = 0;
  let header = true;
  const tokens = text.split(/\s+/).filter((s) => s !== '');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (header) {
      if (token === '$timescale') timescale = tokens[++i];
      else if (token === '$var') {
        const [, , id, name] = tokens.slice(i + 1, i + 5);
        vars.set(id, name);
        i += 5;
      } else if (token === '$enddefinitions') header = false;
      continue;
    }
    if (token === '$dumpvars' || token === '$end') continue;
    if (token.startsWith('#')) t = Number(token.slice(1));
    else changes.push([t, token.slice(1), token[0]]);
  }
  return { timescale, vars, changes };
}

describe('VCD writer', () => {
  it('ids and names', () => {
    expect([vcdId(0), vcdId(1), vcdId(93), vcdId(94)]).toEqual(['!', '"', '~', '!!']);
    expect(vcdName('uno:13')).toBe('uno_13');
    expect(vcdName('btn 1:1.l')).toBe('btn_1_1_l');
  });

  it('emits the exact text for a fixed 2-probe recording, and a reader round-trips it', () => {
    const signals = [
      { name: 'uno:13', times: [0, 1000, 2500, 4000], levels: [0, 1, 0, 1] },
      { name: 'uno:2', times: [0, 2500, 3000], levels: [2, 1, 3] },
    ];
    const text = writeVcd(signals, 'Tue, 20 Oct 2026 04:00:00 GMT');
    expect(text).toBe(
      [
        '$date Tue, 20 Oct 2026 04:00:00 GMT $end',
        '$version Benchtop $end',
        '$timescale 1ns $end',
        '$scope module bench $end',
        '$var wire 1 ! uno_13 $end',
        '$var wire 1 " uno_2 $end',
        '$upscope $end',
        '$enddefinitions $end',
        '$dumpvars',
        '0!',
        'z"',
        '$end',
        '#1000',
        '1!',
        '#2500',
        '0!',
        '1"',
        '#3000',
        'x"',
        '#4000',
        '1!',
        '',
      ].join('\n'),
    );
    const read = readVcd(text);
    expect(read.timescale).toBe('1ns');
    expect([...read.vars]).toEqual([
      ['!', 'uno_13'],
      ['"', 'uno_2'],
    ]);
    const VALUE = ['0', '1', 'z', 'x'];
    const expected = signals.flatMap((s, i) => s.times.map((t, k): [number, string, string] => [t, vcdId(i), VALUE[s.levels[k]]]));
    const order = (a: [number, string, string], b: [number, string, string]) => a[0] - b[0] || a[1].localeCompare(b[1]);
    expect(read.changes.sort(order)).toEqual(expected.sort(order));
  });
});
