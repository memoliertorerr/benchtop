import { describe, expect, it } from 'vitest';
import { highlight, type TokenKind, tokenize } from './tokenize.ts';

/** [kind, text] for every token. */
const kinds = (text: string): [TokenKind, string][] => tokenize(text).map((t) => [t.kind, text.slice(t.from, t.to)]);

describe('Arduino C++ tokenizer (BT42)', () => {
  it('colors keywords, types, Arduino names, strings, chars, numbers and comments', () => {
    const text = [
      '// Blink',
      'const int led = 13; /* the "L" LED */',
      'void setup() { pinMode(led, OUTPUT); Serial.println("hi \\"there\\""); }',
      "char c = '\\n'; float f = 1.5e-3f; unsigned long m = 0xFFul + 0b1010 + 1'000;",
      'if (digitalRead(2) == HIGH) return;',
    ].join('\n');
    expect(kinds(text)).toEqual([
      ['comment', '// Blink'],
      ['keyword', 'const'],
      ['type', 'int'],
      ['number', '13'],
      ['comment', '/* the "L" LED */'],
      ['type', 'void'],
      ['builtin', 'setup'],
      ['builtin', 'pinMode'],
      ['builtin', 'OUTPUT'],
      ['builtin', 'Serial'],
      ['string', '"hi \\"there\\""'],
      ['type', 'char'],
      ['string', "'\\n'"],
      ['type', 'float'],
      ['number', '1.5e-3f'],
      ['type', 'unsigned'],
      ['type', 'long'],
      ['number', '0xFFul'],
      ['number', '0b1010'],
      ['number', "1'000"],
      ['keyword', 'if'],
      ['builtin', 'digitalRead'],
      ['number', '2'],
      ['builtin', 'HIGH'],
      ['keyword', 'return'],
    ]);
  });

  it('colors preprocessor lines (with continuations) and block comments across lines', () => {
    const text = '#include <Wire.h>\n  #define TWICE(x) \\\n    ((x) * 2) // twice\n/* one\n   two */ int x = 0x1e+1;';
    expect(kinds(text)).toEqual([
      ['preprocessor', '#include <Wire.h>'],
      ['preprocessor', '#define TWICE(x) \\\n    ((x) * 2) '],
      ['comment', '// twice'],
      ['comment', '/* one\n   two */'],
      ['type', 'int'],
      ['number', '0x1e'], // hex: 'e' is a digit, '+1' is not an exponent
      ['number', '1'],
    ]);
    // A '#' that isn't first on its line is plain.
    expect(kinds('a # b')).toEqual([]);
  });

  it('survives unterminated strings and comments', () => {
    expect(kinds('"open\nint')).toEqual([
      ['string', '"open'],
      ['type', 'int'],
    ]);
    expect(kinds('/* never closed')).toEqual([['comment', '/* never closed']]);
  });

  it('highlights to escaped HTML spans', () => {
    expect(highlight('if (a < b) x = "<&>";\n')).toBe('<span class="tok-keyword">if</span> (a &lt; b) x = <span class="tok-string">"&lt;&amp;&gt;"</span>;\n ');
  });

  it('tokenizes and highlights a 2,000-line sketch in under 20 ms', () => {
    const block = [
      '#include <Arduino.h>',
      '// A comment line with "quotes" and numbers 123',
      'static const uint8_t pins[] = {2, 3, 4, 5}; /* inline */',
      'void loop() { for (int i = 0; i < 4; i++) digitalWrite(pins[i], (millis() / 250 + i) & 1 ? HIGH : LOW); }',
      'float scale(float v) { return v * 0.0048828125f + 1.0e-3; }',
    ].join('\n');
    const text = Array.from({ length: 400 }, () => block).join('\n');
    expect(text.split('\n')).toHaveLength(2000);
    highlight(text); // warm up
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 5; k++) {
      const start = performance.now();
      highlight(text);
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(20);
  });
});
