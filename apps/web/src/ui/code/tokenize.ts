/**
 * A small tokenizer for Arduino C++ (BT42), enough to color a sketch: keywords and types,
 * Arduino's own names, strings and chars (with escapes), comments (line and block, across
 * lines), numbers (decimal, hex, binary, octal, floats, suffixes), preprocessor lines (with
 * backslash continuations). Everything else is plain. One pass over the text, no regex per
 * character; a 2,000-line sketch tokenizes in a few ms. `highlight()` turns it into HTML spans
 * for the editor's overlay. BT63 adds MicroPython (`tokenizePython`): keywords, builtins and
 * MicroPython's hardware names, `#` comments, strings with prefixes and triple quotes,
 * numbers, decorators (colored as preprocessor lines).
 */

export type TokenKind = 'keyword' | 'type' | 'builtin' | 'string' | 'comment' | 'number' | 'preprocessor' | 'plain';
/** The languages the Code tab colors. */
export type CodeLanguage = 'cpp' | 'python';

export interface Token {
  kind: TokenKind;
  from: number;
  to: number;
}

const KEYWORDS = new Set(
  (
    'alignas alignof asm auto break case catch class const constexpr const_cast continue decltype default delete do ' +
    'dynamic_cast else enum explicit export extern false for friend goto if inline mutable namespace new noexcept ' +
    'nullptr operator private protected public register reinterpret_cast return sizeof static static_assert ' +
    'static_cast struct switch template this throw true try typedef typeid typename union using virtual volatile while'
  ).split(' '),
);

const TYPES = new Set(
  (
    'void bool char short int long float double signed unsigned wchar_t char16_t char32_t size_t boolean byte word ' +
    'String int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t'
  ).split(' '),
);

const BUILTINS = new Set(
  (
    'setup loop pinMode digitalWrite digitalRead analogRead analogWrite analogReference analogReadResolution ' +
    'delay delayMicroseconds millis micros tone noTone pulseIn shiftOut shiftIn attachInterrupt detachInterrupt ' +
    'interrupts noInterrupts map constrain min max abs random randomSeed bitRead bitWrite bitSet bitClear bit ' +
    'dacWrite ledcSetup ledcAttachPin ledcWrite neopixelWrite Serial Serial1 Serial2 Wire SPI F PROGMEM ' +
    'HIGH LOW INPUT OUTPUT INPUT_PULLUP INPUT_PULLDOWN LED_BUILTIN A0 A1 A2 A3 A4 A5 CHANGE RISING FALLING'
  ).split(' '),
);

const isIdentStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isIdent = (c: number): boolean => isIdentStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** Tokens covering the colored parts of `text` (plain stretches are left out). */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let lineStart = true; // only whitespace since the last newline
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      lineStart = true;
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 13) {
      i++;
      continue;
    }
    const start = i;
    // Preprocessor: '#' first on its line, to the end of the line (backslash continues it).
    if (c === 35 && lineStart) {
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 10 && text.charCodeAt(i - 1) !== 92 && !(text.charCodeAt(i - 1) === 13 && text.charCodeAt(i - 2) === 92)) break;
        // A comment ends the directive's coloring.
        if (d === 47 && (text.charCodeAt(i + 1) === 47 || text.charCodeAt(i + 1) === 42)) break;
        i++;
      }
      tokens.push({ kind: 'preprocessor', from: start, to: i });
      lineStart = false;
      continue;
    }
    lineStart = false;
    if (c === 47 && text.charCodeAt(i + 1) === 47) {
      while (i < n && text.charCodeAt(i) !== 10) i++;
      tokens.push({ kind: 'comment', from: start, to: i });
      continue;
    }
    if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      tokens.push({ kind: 'comment', from: start, to: i });
      continue;
    }
    if (c === 34 || c === 39) {
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92) i += 2;
        else if (d === c || d === 10) {
          if (d === c) i++;
          break;
        } else i++;
      }
      tokens.push({ kind: 'string', from: start, to: Math.min(i, n) });
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      const hex = c === 48 && (text.charCodeAt(i + 1) | 32) === 120;
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        // Digits, hex letters, 0x/0b, '.', exponents with signs, suffixes (u, l, f) and ' separators.
        if (isIdent(d) || d === 46 || d === 39) i++;
        else if ((d === 43 || d === 45) && !hex && (text.charCodeAt(i - 1) | 32) === 101) i++;
        else break;
      }
      tokens.push({ kind: 'number', from: start, to: i });
      continue;
    }
    if (isIdentStart(c)) {
      while (i < n && isIdent(text.charCodeAt(i))) i++;
      const word = text.slice(start, i);
      const kind: TokenKind | undefined = KEYWORDS.has(word) ? 'keyword' : TYPES.has(word) ? 'type' : BUILTINS.has(word) ? 'builtin' : undefined;
      if (kind !== undefined) tokens.push({ kind, from: start, to: i });
      continue;
    }
    i++;
  }
  return tokens;
}

const PY_KEYWORDS = new Set(
  (
    'False None True and as assert async await break class continue def del elif else except finally for from ' +
    'global if import in is lambda nonlocal not or pass raise return try while with yield match case'
  ).split(' '),
);

const PY_TYPES = new Set('int float str bytes bytearray bool list dict set tuple object type self cls'.split(' '));

const PY_BUILTINS = new Set(
  (
    'print range len abs min max sum round divmod pow enumerate zip map filter sorted reversed any all iter next ' +
    'open input isinstance hasattr getattr setattr super repr hex bin oct ord chr id hash ' +
    'Exception ValueError TypeError KeyError IndexError OSError RuntimeError KeyboardInterrupt StopIteration ' +
    'machine Pin ADC PWM I2C SoftI2C SPI SoftSPI UART Timer RTC WDT time sleep sleep_ms sleep_us ticks_ms ' +
    'ticks_us ticks_diff ticks_add freq neopixel NeoPixel rp2 StateMachine asm_pio micropython const'
  ).split(' '),
);

/** Python's string prefixes (any case): r, b, f, u, rb, br, fr, rf. */
function stringPrefix(text: string, at: number, end: number): boolean {
  const word = text.slice(at, end).toLowerCase();
  return word === 'r' || word === 'b' || word === 'f' || word === 'u' || word === 'rb' || word === 'br' || word === 'fr' || word === 'rf';
}

/** Tokens of MicroPython source (BT63). */
export function tokenizePython(text: string): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  const string = (start: number, quoteAt: number): void => {
    const q = text.charCodeAt(quoteAt);
    const triple = text.charCodeAt(quoteAt + 1) === q && text.charCodeAt(quoteAt + 2) === q;
    i = quoteAt + (triple ? 3 : 1);
    while (i < n) {
      const d = text.charCodeAt(i);
      if (d === 92) i += 2;
      else if (triple ? d === q && text.charCodeAt(i + 1) === q && text.charCodeAt(i + 2) === q : d === q) {
        i += triple ? 3 : 1;
        break;
      } else if (d === 10 && !triple) break;
      else i++;
    }
    tokens.push({ kind: 'string', from: start, to: Math.min(i, n) });
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    const start = i;
    if (c === 35) {
      while (i < n && text.charCodeAt(i) !== 10) i++;
      tokens.push({ kind: 'comment', from: start, to: i });
      continue;
    }
    if (c === 34 || c === 39) {
      string(start, i);
      continue;
    }
    if (c === 64 && isIdentStart(text.charCodeAt(i + 1))) {
      i++;
      while (i < n && (isIdent(text.charCodeAt(i)) || text.charCodeAt(i) === 46)) i++;
      tokens.push({ kind: 'preprocessor', from: start, to: i });
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (isIdent(d) || d === 46) i++; // digits, 0x/0o/0b, _ separators, exponents, j
        else if ((d === 43 || d === 45) && (text.charCodeAt(i - 1) | 32) === 101 && !/^0x/i.test(text.slice(start, i))) i++;
        else break;
      }
      tokens.push({ kind: 'number', from: start, to: i });
      continue;
    }
    if (isIdentStart(c)) {
      while (i < n && isIdent(text.charCodeAt(i))) i++;
      const q = text.charCodeAt(i);
      if ((q === 34 || q === 39) && stringPrefix(text, start, i)) {
        string(start, i);
        continue;
      }
      const word = text.slice(start, i);
      const kind: TokenKind | undefined = PY_KEYWORDS.has(word) ? 'keyword' : PY_TYPES.has(word) ? 'type' : PY_BUILTINS.has(word) ? 'builtin' : undefined;
      if (kind !== undefined) tokens.push({ kind, from: start, to: i });
      continue;
    }
    i++;
  }
  return tokens;
}

/** The language a sketch file is written in, by its name. */
export function languageOf(fileName: string): CodeLanguage {
  return fileName.toLowerCase().endsWith('.py') ? 'python' : 'cpp';
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The text as HTML with `<span class="tok-<kind>">` around each token (for a `<pre>`). */
export function highlight(text: string, language: CodeLanguage = 'cpp'): string {
  const tokens = language === 'python' ? tokenizePython(text) : tokenize(text);
  let html = '';
  let at = 0;
  for (const t of tokens) {
    if (t.from > at) html += escapeHtml(text.slice(at, t.from));
    html += `<span class="tok-${t.kind}">${escapeHtml(text.slice(t.from, t.to))}</span>`;
    at = t.to;
  }
  if (at < text.length) html += escapeHtml(text.slice(at));
  // A trailing newline needs a character after it to give the <pre> its last line.
  return text.endsWith('\n') ? `${html} ` : html;
}
