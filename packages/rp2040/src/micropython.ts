/**
 * MicroPython sketches on the Pico (BT63). The board runs the stock MicroPython UF2 (fetched by
 * `npm run fetch:micropython`, never committed); a sketch's `.py` files reach it as a desktop
 * IDE puts them there — over USB serial, through the raw REPL — and a soft reboot then runs
 * main.py with the serial monitor attached. `MicroPythonInstaller` is that conversation, fed the
 * device's output byte by byte and ticked with simulated time; the adapter (rp2040-mcu.ts) keeps
 * the serial monitor out of it until main.py starts.
 *
 *   1. prompt   send CR (again every 200 ms) until the friendly REPL's ">>> " appears
 *   2. raw      Ctrl-A; wait for "raw REPL; CTRL-B to exit\r\n>"
 *   3. files    per command (a file's text in ≤ 2 KB parts, `open(…, 'w' | 'a').write(…)`):
 *               the code, Ctrl-D; wait for "OK" stdout Ctrl-D stderr Ctrl-D ">" — stderr not
 *               empty fails the install with MicroPython's own message
 *   4. friendly Ctrl-B; wait for the banner's ">>> "
 *   5. reboot   Ctrl-D; "MPY: soft reboot\r\n" — everything after it is the sketch's output
 *
 * The sketch's main file is written as main.py (MicroPython runs main.py at boot); the others
 * keep their names. File text travels as Python string literals in printable ASCII only, so no
 * byte of it is a control character the REPL acts on (Ctrl-C would interrupt the install).
 */

import type { FirmwareImage } from '@benchtop/core';

export type MicroPythonSketch = Extract<FirmwareImage, { format: 'micropython' }>;

/** The interpreter UF2 isn't loaded: the board can't run a MicroPython sketch. */
export const CODE_MICROPYTHON_MISSING = 'micropython-missing';
/** Putting the sketch on the board failed (no REPL, or MicroPython refused a file). */
export const CODE_MICROPYTHON_INSTALL = 'micropython-install';
export const MICROPYTHON_MISSING_MESSAGE =
  'MicroPython not installed — run npm run fetch:micropython (it downloads the stock v1.29.0 UF2s, ≈ 1.5 MB, into .cache/micropython after you approve it).';

/** Python source text as a single-quoted literal in printable ASCII. */
export function pythonLiteral(text: string): string {
  let out = "'";
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) as number;
    if (code > 0xffff) i++; // the surrogate pair's second half
    if (code === 0x5c) out += '\\\\';
    else if (code === 0x27) out += "\\'";
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0d) out += '\\r';
    else if (code === 0x09) out += '\\t';
    else if (code >= 0x20 && code < 0x7f) out += String.fromCharCode(code);
    else if (code < 0x100) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += `\\U${code.toString(16).padStart(8, '0')}`;
  }
  return `${out}'`;
}

/** Characters of a file per raw-REPL command, and per `write` call inside one. */
const COMMAND_CHARS = 2048;
const WRITE_CHARS = 256;

/** The raw-REPL commands that write the sketch's files (the main file as main.py). */
export function installCommands(sketch: MicroPythonSketch): string[] {
  const commands: string[] = [];
  const names = Object.keys(sketch.files).sort();
  for (const name of names) {
    const target = name === sketch.main ? 'main.py' : name;
    if (name !== sketch.main && target === 'main.py') continue; // the main file wins main.py
    const text = sketch.files[name];
    for (let at = 0; at === 0 || at < text.length; at += COMMAND_CHARS) {
      const part = text.slice(at, at + COMMAND_CHARS);
      let code = `f=open(${pythonLiteral(target)},${at === 0 ? "'w'" : "'a'"})\n`;
      for (let w = 0; w < part.length; w += WRITE_CHARS) code += `f.write(${pythonLiteral(part.slice(w, w + WRITE_CHARS))})\n`;
      code += 'f.close()\n';
      commands.push(code);
    }
  }
  return commands;
}

type Stage = 'prompt' | 'raw' | 'files' | 'friendly' | 'reboot' | 'running' | 'failed';

const CTRL_A = 0x01;
const CTRL_B = 0x02;
const CTRL_D = 0x04;
const POKE_MS = 200;
/** Simulated time the REPL may take to appear after power-up, and each later stage to answer. */
const PROMPT_TIMEOUT_MS = 15_000;
const STAGE_TIMEOUT_MS = 10_000;
const REBOOT_LINE = 'MPY: soft reboot\r\n';

export interface InstallerPort {
  /** Sends bytes to the device's REPL (USB serial input). */
  send(bytes: readonly number[]): void;
  /** Reports a failed install (CODE_MICROPYTHON_INSTALL). */
  fail(message: string): void;
}

export class MicroPythonInstaller {
  stage: Stage = 'prompt';
  private readonly commands: string[];
  private command = 0;
  /** What the device said in the current stage. */
  private heard = '';
  private stageSince = 0;
  private lastPoke = -Infinity;
  private readonly port: InstallerPort;

  constructor(sketch: MicroPythonSketch, port: InstallerPort) {
    this.commands = installCommands(sketch);
    this.port = port;
  }

  /** Whether the installer still owns the serial line. */
  get active(): boolean {
    return this.stage !== 'running' && this.stage !== 'failed';
  }

  /** Simulated time passes: pokes the REPL while waiting for it, and gives up on silence. */
  tick(nowMs: number): void {
    if (!this.active) return;
    if (this.stage === 'prompt' && nowMs - this.lastPoke >= POKE_MS) {
      this.lastPoke = nowMs;
      this.port.send([0x0d]);
    }
    const limit = this.stage === 'prompt' ? PROMPT_TIMEOUT_MS : STAGE_TIMEOUT_MS;
    if (nowMs - this.stageSince > limit) this.failWith(this.stage === 'prompt' ? `MicroPython's REPL didn't answer on USB serial within ${limit / 1000} s` : `MicroPython stopped answering while the sketch was being written (${this.stage})`);
  }

  /** One byte of device output; returns true when the installer consumed it (the serial monitor doesn't see it). */
  output(byte: number, nowMs: number): boolean {
    if (!this.active) return false;
    this.heard += String.fromCharCode(byte);
    switch (this.stage) {
      case 'prompt':
        if (this.heard.endsWith('>>> ')) this.enter('raw', nowMs, [CTRL_A]);
        break;
      case 'raw':
        if (this.heard.endsWith('CTRL-B to exit\r\n>')) this.nextCommand(nowMs);
        break;
      case 'files': {
        const reply = /^OK([\s\S]*?)\x04([\s\S]*?)\x04>$/.exec(this.heard);
        if (reply === null) break;
        if (reply[2].trim() !== '') this.failWith(`MicroPython refused the sketch: ${reply[2].trim()}`);
        else this.nextCommand(nowMs);
        break;
      }
      case 'friendly':
        if (this.heard.endsWith('>>> ')) this.enter('reboot', nowMs, [CTRL_D]);
        break;
      case 'reboot':
        if (this.heard.endsWith(REBOOT_LINE)) {
          this.stage = 'running';
          this.heard = '';
        }
        break;
    }
    return true;
  }

  private nextCommand(nowMs: number): void {
    if (this.command >= this.commands.length) {
      this.enter('friendly', nowMs, [CTRL_B]);
      return;
    }
    const code = this.commands[this.command++];
    const bytes: number[] = [];
    for (let i = 0; i < code.length; i++) bytes.push(code.charCodeAt(i)); // printable ASCII and \n only
    bytes.push(CTRL_D);
    this.enter('files', nowMs, bytes);
  }

  private enter(stage: Stage, nowMs: number, bytes: readonly number[]): void {
    this.stage = stage;
    this.stageSince = nowMs;
    this.heard = '';
    this.port.send(bytes);
  }

  private failWith(message: string): void {
    this.stage = 'failed';
    this.heard = '';
    this.port.fail(message);
  }
}
