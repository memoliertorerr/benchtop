import { describe, expect, it } from 'vitest';
import type { ProjectDoc } from '../contracts/project.ts';
import { emptyProject } from './empty.ts';
import { MAX_ERRORS, MAX_PARTS, MAX_WAYPOINTS, parseProject, type ValidationError } from './validate.ts';

// Test documents are mutated freely through `any`; parseProject is what gives them a type.
type Loose = any;

/** An Uno, a resistor and an LED, wired D13 → resistor → LED anode, with blink firmware. */
function unoCircuit(): ProjectDoc {
  return {
    format: 1,
    name: 'Blink',
    parts: [
      { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
      { id: 'r1', type: 'resistor', x: 80.01, y: 10.16, rotation: 90, props: { ohms: 220 } },
      { id: 'led1', type: 'led', x: 90.17, y: 10.16, rotation: 0, props: { color: 'red', flip: false } },
    ],
    wires: [
      { id: 'w1', from: { part: 'uno', pin: '13' }, to: { part: 'r1', pin: '1' }, waypoints: [], color: 'green' },
      {
        id: 'w2',
        from: { part: 'r1', pin: '2' },
        to: { part: 'led1', pin: 'A' },
        waypoints: [{ x: 85.09, y: 5.08 }],
        color: '#2a9d8f',
      },
    ],
    firmware: { uno: { kind: 'file', name: 'blink.hex', format: 'hex' } },
  };
}

function loose(): Loose {
  return structuredClone(unoCircuit());
}

function errorsOf(input: unknown): ValidationError[] {
  const result = parseProject(input);
  if (result.ok) throw new Error('expected the document to be rejected');
  return result.errors;
}

describe('parseProject accepts', () => {
  it('a minimal document', () => {
    const doc = emptyProject('Empty');
    expect(parseProject(doc)).toEqual({ ok: true, doc });
    expect(parseProject(JSON.parse(JSON.stringify(doc)))).toEqual({ ok: true, doc });
  });

  it('an Uno, a resistor, an LED and two wires', () => {
    const doc = unoCircuit();
    const result = parseProject(JSON.parse(JSON.stringify(doc)));
    expect(result).toEqual({ ok: true, doc });
  });

  it('returns a freshly built document without unknown keys', () => {
    const input = loose();
    input.extra = 'dropped';
    input.parts[0].selected = true;
    input.parts[1].props.ohms = 1000;
    input.wires[1].waypoints[0].z = 3;
    input.wires[0].from.side = 'left';
    input.firmware.uno.bytes = [1, 2, 3];
    const result = parseProject(input);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const expected = unoCircuit();
    expected.parts[1].props.ohms = 1000;
    expect(result.doc).toStrictEqual(expected);
    expect(result.doc).not.toBe(input);
    expect(result.doc.parts[1].props).not.toBe(input.parts[1].props);
    expect(result.doc.wires[1].waypoints[0]).not.toBe(input.wires[1].waypoints[0]);
  });

  it('a sketch firmware reference, and wire ids that equal part ids', () => {
    const input = loose();
    input.firmware.uno = { kind: 'sketch', path: '/Users/me/Arduino/blink', fqbn: 'arduino:avr:uno' };
    input.wires[0].id = 'uno';
    expect(parseProject(input).ok).toBe(true);
  });

  it('rotation -0 as 0', () => {
    const input = loose();
    input.parts[0].rotation = -0;
    const result = parseProject(input);
    expect(result.ok && Object.is(result.doc.parts[0].rotation, 0)).toBe(true);
  });
});

describe('parseProject rejects, naming the field', () => {
  const cases: [string, string, (doc: Loose) => void][] = [
    ['format 2', '/format', (d) => (d.format = 2)],
    ['a duplicate part id', '/parts/3/id', (d) => d.parts.push({ ...d.parts[1], id: 'r1' })],
    ['the id "1led"', '/parts/3/id', (d) => d.parts.push({ ...d.parts[2], id: '1led' })],
    ['rotation 45', '/parts/1/rotation', (d) => (d.parts[1].rotation = 45)],
    ['x NaN', '/parts/2/x', (d) => (d.parts[2].x = Number.NaN)],
    ['a wire endpoint naming a missing part', '/wires/1/to/part', (d) => (d.wires[1].to.part = 'led2')],
    [
      `${MAX_PARTS + 1} parts`,
      '/parts',
      (d) => {
        for (let i = d.parts.length; i < MAX_PARTS + 1; i++) {
          d.parts.push({ id: `p${i}`, type: 'led', x: 0, y: 0, rotation: 0, props: {} });
        }
      },
    ],
    [
      `a wire with ${MAX_WAYPOINTS + 1} waypoints`,
      '/wires/1/waypoints',
      (d) => (d.wires[1].waypoints = Array.from({ length: MAX_WAYPOINTS + 1 }, (_, i) => ({ x: i, y: 0 }))),
    ],
    ['a prop named __proto__', '/parts/1/props/__proto__', (d) => (d.parts[1].props = JSON.parse('{"__proto__": 1}'))],
    ['an object prop value', '/parts/1/props/ohms', (d) => (d.parts[1].props.ohms = { value: 220 })],
    ['a url() wire color', '/wires/0/color', (d) => (d.wires[0].color = 'url(https://example.com/x)')],
    ['an empty part type', '/parts/0/type', (d) => (d.parts[0].type = '')],
    ['a missing pin name', '/wires/0/from/pin', (d) => delete d.wires[0].from.pin],
    ['a duplicate wire id', '/wires/1/id', (d) => (d.wires[1].id = 'w1')],
    ['firmware for a missing part', '/firmware/nano', (d) => (d.firmware.nano = d.firmware.uno)],
    ['an unknown firmware format', '/firmware/uno/format', (d) => (d.firmware.uno.format = 'srec')],
    ['an unknown firmware kind', '/firmware/uno/kind', (d) => (d.firmware.uno = { kind: 'url', url: 'x' })],
    ['a 257-character name', '/name', (d) => (d.name = 'x'.repeat(257))],
    ['a missing wires list', '/wires', (d) => delete d.wires],
  ];

  it.each(cases)('%s → %s', (_label, path, mutate) => {
    const input = loose();
    mutate(input);
    expect(errorsOf(input)).toEqual([{ path, message: expect.any(String) }]);
  });

  it('a non-object document, at the root path', () => {
    expect(errorsOf(null)).toEqual([{ path: '', message: 'must be an object, got null' }]);
    expect(errorsOf([])).toEqual([{ path: '', message: 'must be an object, got an array' }]);
  });

  it('fields that are only inherited, not own', () => {
    const input = Object.create(unoCircuit());
    expect(errorsOf(input).map((e) => e.path)).toEqual(['/format', '/name', '/parts', '/wires', '/firmware']);
  });
});

describe('parseProject error collection', () => {
  it('collects several errors in one pass', () => {
    const input = loose();
    input.format = 2;
    input.parts[1].rotation = 45;
    input.parts[2].x = Number.NaN;
    input.wires[1].to.part = 'led2';
    expect(errorsOf(input).map((e) => e.path)).toEqual([
      '/format',
      '/parts/1/rotation',
      '/parts/2/x',
      '/wires/1/to/part',
    ]);
  });

  it(`stops at ${MAX_ERRORS} errors`, () => {
    const input = loose();
    for (let i = 0; i < 150; i++) {
      input.parts.push({ id: `p${i}`, type: 'led', x: 0, y: 0, rotation: 45, props: {} });
    }
    expect(errorsOf(input)).toHaveLength(MAX_ERRORS);
  });

  it('escapes / and ~ in paths built from keys', () => {
    const input = loose();
    input.firmware['a/b~c'] = input.firmware.uno;
    expect(errorsOf(input).map((e) => e.path)).toEqual(['/firmware/a~1b~0c']);
  });
});

describe('inline sketches (BT42)', () => {
  const inline = (files: Record<string, unknown>, main: unknown = 'sketch.ino', fqbn: unknown = 'arduino:avr:uno') => {
    const input = loose();
    input.firmware.uno = { kind: 'inline', fqbn, files, main };
    return input;
  };
  const blink = 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() {}\n';

  it('accepts the files, main and fqbn, and copies them', () => {
    const files = { 'sketch.ino': blink, 'pins.h': '#define LED 13\n', 'util.cpp': '// ü ✓\n' };
    const input = inline(files);
    const result = parseProject(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.firmware.uno).toEqual({ kind: 'inline', fqbn: 'arduino:avr:uno', files, main: 'sketch.ino' });
    expect(result.doc.firmware.uno).not.toBe(input.firmware.uno);
  });

  it('accepts a MicroPython sketch: .py files, a .py main (BT63)', () => {
    const files = { 'main.py': 'import lib\nlib.run()\n', 'lib.py': 'def run():\n    print("hi")\n' };
    const result = parseProject(inline(files, 'main.py', 'micropython:rp2:pico'));
    expect(result.ok && result.doc.firmware.uno).toEqual({ kind: 'inline', fqbn: 'micropython:rp2:pico', files, main: 'main.py' });
  });

  it('leaves older documents unchanged', () => {
    const input = loose();
    const result = parseProject(input);
    expect(result.ok && result.doc).toEqual(unoCircuit());
  });

  it('takes 32 files and exactly 256 KB of source (counted in UTF-8)', () => {
    const files: Record<string, string> = { 'sketch.ino': blink };
    for (let i = 1; i < 32; i++) files[`f${i}.h`] = '';
    expect(parseProject(inline(files)).ok).toBe(true);
    // 'é' is two bytes in UTF-8: 128 Ki of them is exactly the cap.
    expect(parseProject(inline({ 'sketch.ino': 'é'.repeat(128 * 1024) })).ok).toBe(true);
  });

  const rejects: [string, string, ReturnType<typeof inline>][] = [
    ['33 files', '/firmware/uno/files', inline(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i === 0 ? 'sketch.ino' : `f${i}.h`, ''])))],
    ['no files', '/firmware/uno/files', inline({})],
    ['a folder in a name', '/firmware/uno/files/..~1secret.h', inline({ 'sketch.ino': blink, '../secret.h': '' })],
    ['a hidden file', '/firmware/uno/files/.hidden.h', inline({ 'sketch.ino': blink, '.hidden.h': '' })],
    ['another extension', '/firmware/uno/files/run.sh', inline({ 'sketch.ino': blink, 'run.sh': 'rm -rf /' })],
    ['a non-string file', '/firmware/uno/files/sketch.ino', inline({ 'sketch.ino': 42 })],
    ['source over 256 KB', '/firmware/uno/files', inline({ 'sketch.ino': 'x'.repeat(256 * 1024 + 1) })],
    ['main not a .ino', '/firmware/uno/main', inline({ 'sketch.ino': blink, 'pins.h': '' }, 'pins.h')],
    ['main not among the files', '/firmware/uno/main', inline({ 'other.ino': blink }, 'sketch.ino')],
    ['no fqbn', '/firmware/uno/fqbn', inline({ 'sketch.ino': blink }, 'sketch.ino', '')],
    ['a .py in an Arduino sketch', '/firmware/uno/files/main.py', inline({ 'sketch.ino': blink, 'main.py': '' })],
    ['a .ino in a MicroPython sketch', '/firmware/uno/files/sketch.ino', inline({ 'main.py': '', 'sketch.ino': blink }, 'main.py', 'micropython:rp2:pico')],
    ['a MicroPython main that is not .py', '/firmware/uno/main', inline({ 'main.py': '' }, 'sketch.ino', 'micropython:rp2:pico')],
  ];
  for (const [what, path, input] of rejects) {
    it(`rejects ${what}`, () => {
      const result = parseProject(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((e) => e.path)).toContain(path);
    });
  }
});
