/**
 * Generates packages/esp32/src/soc/reg-defaults.generated.ts: the reset value of every ESP32
 * peripheral register whose fields the ESP-IDF headers annotate (`/* NAME : R/W ;bitpos:[hi:lo]
 * ;default: N'hV ; *\/`), as {address → value} for the nonzero ones. Run by hand when the
 * headers change:
 *   node scripts/gen-esp32-reg-defaults.ts
 * Sources: the installed esp32 Arduino core's ESP-IDF headers (Apache-2.0, Espressif),
 * SDK/include/soc/esp32/include/soc/<name>_reg.h with the DR_REG_* bases of soc.h. Register
 * macros with an instance parameter (`UART_CLKDIV_REG(i)`) expand for every instance. The
 * address expressions are evaluated by a small arithmetic parser (no eval).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = join(homedir(), 'Library/Arduino15/packages/esp32/hardware/esp32/2.0.17/tools/sdk/esp32');
const SOC = join(SDK, 'include/soc/esp32/include/soc');
const OUT = join(ROOT, 'packages/esp32/src/soc/reg-defaults.generated.ts');

/** Header → instances of its `(i)` register macros. */
const HEADERS: [string, number][] = [
  ['dport_reg.h', 1],
  ['rtc_cntl_reg.h', 1],
  ['efuse_reg.h', 1],
  ['syscon_reg.h', 1],
  ['timer_group_reg.h', 2],
  ['uart_reg.h', 3],
  ['gpio_reg.h', 1],
  ['rtc_io_reg.h', 1],
  ['sens_reg.h', 1],
  ['ledc_reg.h', 1],
  ['i2c_reg.h', 2],
  ['spi_reg.h', 4],
  ['rmt_reg.h', 1],
];

// ── Macros ────────────────────────────────────────────────────────────────────────────────

interface Macro {
  param: string | null;
  body: string;
}

const macros = new Map<string, Macro>();

function collectMacros(text: string): void {
  // Join continuation lines, then read `#define NAME body` and `#define NAME(p) body`.
  for (const line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const m = /^\s*#define\s+([A-Za-z_]\w*)(\(\s*([A-Za-z_]\w*)\s*\))?\s+(.*?)\s*(\/\*.*)?$/.exec(line);
    if (m === null) continue;
    macros.set(m[1], { param: m[3] ?? null, body: m[4] });
  }
}

// ── A small expression evaluator: numbers, macros, ( ), unary - ~ !, * / % + - << >> < > <= >=
//    == != & ^ | && || ?: — enough for the headers' address expressions. ─────────────────────

type Token = { kind: 'num'; value: number } | { kind: 'id'; name: string } | { kind: 'op'; op: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(0[xX][0-9a-fA-F]+|\d+)[uUlL]*|\s*([A-Za-z_]\w*)|\s*(<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%()~!<>&^|?:,])/y;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    re.lastIndex = index;
    const m = re.exec(source);
    if (m === null) throw new Error(`cannot tokenize "${source.slice(index)}" in "${source}"`);
    index = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ kind: 'num', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ kind: 'id', name: m[2] });
    else tokens.push({ kind: 'op', op: m[3] });
  }
  return tokens;
}

function evaluate(source: string, env: ReadonlyMap<string, number>, depth = 0): number {
  if (depth > 20) throw new Error(`macro recursion in "${source}"`);
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (op: string): boolean => {
    const t = peek();
    return t !== undefined && t.kind === 'op' && t.op === op;
  };
  const expect = (op: string): void => {
    if (!isOp(op)) throw new Error(`expected ${op} in "${source}"`);
    pos++;
  };

  const primary = (): number => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`unexpected end of "${source}"`);
    if (t.kind === 'num') return t.value;
    if (t.kind === 'op') {
      if (t.op === '(') {
        const v = ternary();
        expect(')');
        return v;
      }
      if (t.op === '-') return -primary();
      if (t.op === '~') return ~primary();
      if (t.op === '!') return primary() === 0 ? 1 : 0;
      if (t.op === '+') return primary();
      throw new Error(`unexpected ${t.op} in "${source}"`);
    }
    const bound = env.get(t.name);
    if (bound !== undefined) return bound;
    const macro = macros.get(t.name);
    if (macro === undefined) throw new Error(`unknown identifier ${t.name} in "${source}"`);
    if (macro.param === null) return evaluate(macro.body, env, depth + 1);
    expect('(');
    const arg = ternary();
    expect(')');
    return evaluate(macro.body, new Map([...env, [macro.param, arg]]), depth + 1);
  };

  const binary = (level: number): number => {
    const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
    if (level === LEVELS.length) return primary();
    let left = binary(level + 1);
    for (;;) {
      const t = peek();
      if (t === undefined || t.kind !== 'op' || !LEVELS[level].includes(t.op)) return left;
      pos++;
      const right = binary(level + 1);
      switch (t.op) {
        case '||': left = left !== 0 || right !== 0 ? 1 : 0; break;
        case '&&': left = left !== 0 && right !== 0 ? 1 : 0; break;
        case '|': left = left | right; break;
        case '^': left = left ^ right; break;
        case '&': left = left & right; break;
        case '==': left = left === right ? 1 : 0; break;
        case '!=': left = left !== right ? 1 : 0; break;
        case '<': left = left < right ? 1 : 0; break;
        case '>': left = left > right ? 1 : 0; break;
        case '<=': left = left <= right ? 1 : 0; break;
        case '>=': left = left >= right ? 1 : 0; break;
        case '<<': left = left << right; break;
        case '>>': left = left >>> right; break;
        case '+': left = left + right; break;
        case '-': left = left - right; break;
        case '*': left = left * right; break;
        case '/': left = Math.trunc(left / right); break;
        default: left = left % right;
      }
    }
  };

  const ternary = (): number => {
    const condition = binary(0);
    if (!isOp('?')) return condition;
    pos++;
    const a = ternary();
    expect(':');
    const b = ternary();
    return condition !== 0 ? a : b;
  };

  const value = ternary();
  if (pos !== tokens.length) throw new Error(`trailing tokens in "${source}"`);
  return value;
}

// ── Field annotations ─────────────────────────────────────────────────────────────────────

/** `N'hV` / `N'bV` / `N'dV` / plain numbers → value masked to N bits. */
function parseDefault(text: string): number | undefined {
  const m = /^(\d+)?'([hHbBdD])([0-9a-fA-F_]+)$/.exec(text.trim());
  if (m === null) {
    const n = /^(0x[0-9a-fA-F]+|\d+)$/.exec(text.trim());
    return n === null ? undefined : Number(n[1]);
  }
  const digits = m[3].replace(/_/g, '');
  const radix = m[2].toLowerCase() === 'h' ? 16 : m[2].toLowerCase() === 'b' ? 2 : 10;
  let value = Number.parseInt(digits, radix);
  if (m[1] !== undefined) {
    const width = Number(m[1]);
    if (width < 32) value %= 2 ** width;
  }
  return value;
}

interface Register {
  name: string;
  addresses: number[];
  value: number;
}

function parseHeader(file: string, instances: number): { registers: Register[]; skipped: string[] } {
  const text = readFileSync(join(SOC, file), 'utf8');
  const registers: Register[] = [];
  const skipped: string[] = [];
  let current: Register | null = null;
  for (const line of text.split(/\r?\n/)) {
    const reg = /^\s*#define\s+([A-Z0-9_]+_REG)(\(\s*i\s*\))?\s+(.+?)\s*(\/\*.*)?$/.exec(line);
    if (reg !== null) {
      const indexed = reg[2] !== undefined;
      const addresses: number[] = [];
      try {
        for (let i = 0; i < (indexed ? instances : 1); i++) addresses.push(evaluate(reg[3], new Map([['i', i]])) >>> 0);
      } catch (error) {
        skipped.push(`${reg[1]}: ${(error as Error).message}`);
        current = null;
        continue;
      }
      if (!addresses.every(isRegisterAddress)) {
        current = null; // a field mask named *_REG, or an AHB-alias name
        continue;
      }
      current = { name: reg[1], addresses, value: 0 };
      registers.push(current);
      continue;
    }
    const field = /\/\*\s*([A-Za-z0-9_]+)\s*:\s*[^;]*;\s*bitpos:\s*\[(\d+)(?::(\d+))?\]\s*;\s*default:\s*([^;]*?)\s*;/.exec(line);
    if (field !== null && current !== null) {
      const hi = Number(field[2]);
      const lo = field[3] === undefined ? hi : Number(field[3]);
      const value = parseDefault(field[4]);
      if (value === undefined) {
        // gpio_reg.h writes `default: x` (unknown) for its pad fields: those reset as 0 here.
        skipped.push(`${current.name}.${field[1]}: default "${field[4]}"`);
        continue;
      }
      const width = hi - lo + 1;
      const fieldMask = width >= 32 ? 0xffffffff : 2 ** width - 1;
      current.value = (current.value | ((value & fieldMask) * 2 ** lo)) >>> 0; // `*` keeps bit 31 positive
    }
  }
  return { registers, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────────────────────

collectMacros(readFileSync(join(SOC, 'soc.h'), 'utf8'));
for (const [file] of HEADERS) collectMacros(readFileSync(join(SOC, file), 'utf8'));
macros.set('BIT', { param: 'nr', body: '(1 << (nr))' }); // esp_bit_defs.h

/** Peripheral register space (the AHB alias 0x6000_0000+ names the same registers). */
const isRegisterAddress = (a: number): boolean => a >= 0x3ff00000 && a < 0x3ff80000;

const defaults = new Map<number, number>();
let registerCount = 0;
const report: string[] = [];
for (const [file, instances] of HEADERS) {
  const { registers, skipped } = parseHeader(file, instances);
  registerCount += registers.reduce((n, r) => n + r.addresses.length, 0);
  for (const r of registers) for (const address of r.addresses) if (r.value !== 0) defaults.set(address, r.value);
  report.push(`${file}: ${registers.length} registers${skipped.length > 0 ? `, skipped ${skipped.length}: ${skipped.slice(0, 3).join('; ')}` : ''}`);
}

const entries = [...defaults.entries()].sort((a, b) => a[0] - b[0]);
const hex = (v: number): string => `0x${v.toString(16).padStart(8, '0')}`;
const body = entries.map(([a, v]) => `  ${hex(a)}, ${hex(v)},`).join('\n');
writeFileSync(
  OUT,
  `/**
 * GENERATED by scripts/gen-esp32-reg-defaults.ts — do not edit. Reset values of the ESP32
 * peripheral registers whose fields carry \`default:\` annotations in ESP-IDF v4.4's headers
 * (${HEADERS.map(([f]) => f).join(', ')}; Apache-2.0, Espressif Systems), as flat
 * [address, value] pairs for the nonzero ones (${entries.length} of ${registerCount} registers).
 */

export const REG_DEFAULT_PAIRS: readonly number[] = [
${body}
];
`,
);
console.info(report.join('\n'));
console.info(`wrote ${entries.length} nonzero defaults of ${registerCount} registers to ${OUT}`);
