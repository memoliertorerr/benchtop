import { describe, expect, it } from 'vitest';
import { CODE_MICROPYTHON_INSTALL, CODE_MICROPYTHON_MISSING, installCommands, MicroPythonInstaller, pythonLiteral } from './micropython.ts';
import { cachedMicroPython, micropythonFixture } from './micropython.test-helper.ts';
import { createRp2040Mcu, RP2040_CLOCK_HZ } from './rp2040-mcu.ts';
import { edgeTimes, runMs } from './rp2040.test-helper.ts';

// BT63: MicroPython sketches on the stock v1.29.0 UF2 (fetched to .cache/micropython; these tests
// fail with instructions without it), put on the board through the raw REPL.

function bootSketch(name: string) {
  const problems: string[] = [];
  const mcu = createRp2040Mcu({ micropython: cachedMicroPython(), onProblem: (p) => p.code !== 'rp2040-unimplemented' && problems.push(`${p.code}: ${p.message}`) });
  mcu.load(micropythonFixture(name));
  let serial = '';
  mcu.uart(0)?.onTransmit((b) => (serial += String.fromCharCode(b)));
  return { mcu, problems, serial: () => serial };
}

describe('MicroPython sketches: the raw-REPL install', () => {
  it('quotes file text as printable ASCII Python literals', () => {
    expect(pythonLiteral('a\'b\\c\n\r\t')).toBe("'a\\'b\\\\c\\n\\r\\t'");
    expect(pythonLiteral('\x03\x7f é € 😀')).toBe("'\\x03\\x7f \\xe9 \\u20ac \\U0001f600'");
    expect(pythonLiteral('')).toBe("''");
  });

  it('writes the main file as main.py, the others by name, long files in parts', () => {
    const long = 'x'.repeat(5000);
    const commands = installCommands({ format: 'micropython', files: { 'app.py': 'run()\n', 'lib.py': long }, main: 'app.py' });
    expect(commands[0]).toBe("f=open('main.py','w')\nf.write('run()\\n')\nf.close()\n");
    expect(commands.slice(1).map((c) => c.split('\n')[0])).toEqual(["f=open('lib.py','w')", "f=open('lib.py','a')", "f=open('lib.py','a')"]);
    expect(commands.slice(1).join('').match(/x/g)?.length).toBe(5000);
    expect(installCommands({ format: 'micropython', files: { 'main.py': '' }, main: 'main.py' })).toEqual(["f=open('main.py','w')\nf.close()\n"]);
  });

  it('follows the REPL through raw mode and fails with MicroPython\'s own message', () => {
    const sent: string[] = [];
    const failures: string[] = [];
    const installer = new MicroPythonInstaller({ format: 'micropython', files: { 'main.py': 'print(1)\n' }, main: 'main.py' }, {
      send: (bytes) => sent.push(String.fromCharCode(...bytes)),
      fail: (message) => failures.push(message),
    });
    const say = (text: string): void => {
      for (const c of text) installer.output(c.charCodeAt(0), 0);
    };
    installer.tick(0);
    expect(sent).toEqual(['\r']);
    say('\r\n>>> ');
    expect(sent.at(-1)).toBe('\x01');
    say('raw REPL; CTRL-B to exit\r\n>');
    expect(sent.at(-1)).toBe("f=open('main.py','w')\nf.write('print(1)\\n')\nf.close()\n\x04");
    say('OK\x04Traceback (most recent call last):\r\nOSError: 28\r\n\x04>');
    expect(installer.active).toBe(false);
    expect(failures).toEqual(['MicroPython refused the sketch: Traceback (most recent call last):\r\nOSError: 28']);
  });

  it('gives up when the REPL never answers', () => {
    const failures: string[] = [];
    const installer = new MicroPythonInstaller({ format: 'micropython', files: { 'main.py': '' }, main: 'main.py' }, { send: () => {}, fail: (m) => failures.push(m) });
    for (let ms = 0; ms <= 16_000; ms += 50) installer.tick(ms);
    expect(failures).toEqual(["MicroPython's REPL didn't answer on USB serial within 15 s"]);
  });
});

describe('MicroPython sketches on the Pico', () => {
  it('hello: print and a traceback reach USB serial, then the REPL answers what you type', () => {
    const t = bootSketch('hello');
    runMs(t.mcu, 300);
    expect(t.serial()).toMatch(/^hello\r\n45\r\nTraceback \(most recent call last\):\r\n {2}File "main.py", line 5, in <module>\r\nValueError: boom\r\nMicroPython v1\.29\.0 on 2026-08-24; Raspberry Pi Pico with RP2040\r\nType "help\(\)" for more information\.\r\n>>> $/);
    t.mcu.uart(0)?.receive(new TextEncoder().encode('print(6 * 7)\r'));
    runMs(t.mcu, 50);
    expect(t.serial()).toMatch(/>>> print\(6 \* 7\)\r\n42\r\n>>> $/);
    expect(t.problems).toEqual([]);
  });

  it('blink: Pin("LED").toggle() every 250 ms ±1 %, and a reset runs the sketch again', () => {
    const t = bootSketch('blink');
    const edges = edgeTimes(t.mcu, 'GPIO25');
    runMs(t.mcu, 1300);
    const rises = edges.times.filter((_, i) => edges.levels[i] === 1);
    expect(rises.length).toBeGreaterThanOrEqual(2);
    const toggles = edges.times.filter((_, i) => edges.levels[i] >= 0).slice(1);
    for (let i = 1; i < toggles.length; i++) expect(Math.abs(toggles[i] - toggles[i - 1] - 250)).toBeLessThan(2.5);
    expect(t.serial()).toContain('blink 4\r\n');
    t.mcu.reset();
    runMs(t.mcu, 300);
    expect(t.serial().match(/blink 0\r\n/g)?.length).toBe(2);
    expect(t.problems).toEqual([]);
  });

  it('without the interpreter a sketch halts with micropython-missing and the fetch command', () => {
    const problems: string[] = [];
    const mcu = createRp2040Mcu({ onProblem: (p) => problems.push(`${p.code}: ${p.message}`) });
    mcu.load(micropythonFixture('hello'));
    const result = mcu.runUntil(RP2040_CLOCK_HZ / 1000);
    expect(result.reason).toBe('halted');
    expect(result.detail).toMatch(/npm run fetch:micropython/);
    expect(problems[0]).toMatch(new RegExp(`^${CODE_MICROPYTHON_MISSING}: `));
    expect(CODE_MICROPYTHON_INSTALL).toBe('micropython-install');
  });

  it('a launch of core 1 returns (the bootrom echoes it) and reports that core 1 code does not run', () => {
    const problems: string[] = [];
    const mcu = createRp2040Mcu({ micropython: cachedMicroPython(), onProblem: (p) => p.code === 'rp2040-core1' && problems.push(p.message) });
    mcu.load({ format: 'micropython', files: { 'main.py': 'import _thread\n_thread.start_new_thread(lambda: None, ())\nprint("started")\n' }, main: 'main.py' });
    let serial = '';
    mcu.uart(0)?.onTransmit((b) => (serial += String.fromCharCode(b)));
    runMs(mcu, 300);
    expect(serial).toContain('started\r\n');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/launched core 1 .* doesn't simulate/);
  });
});
