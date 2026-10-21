import { describe, expect, it } from 'vitest';
import { Hd44780 } from './hd44780.ts';

/** What a 4-bit bus carries: the nibble on D7..D4, D3..D0 floating (reads 0). */
const nibble = (n: number): number => (n & 0x0f) << 4;

/** LiquidCrystal's 4-bit init: three 0x3 nibbles, one 0x2, then function set 0x28. */
function init4bit(lcd: Hd44780): void {
  for (const n of [0x3, 0x3, 0x3, 0x2]) lcd.latch(false, nibble(n));
  send4(lcd, false, 0x28);
}

function send4(lcd: Hd44780, rs: boolean, byte: number): void {
  lcd.latch(rs, nibble(byte >> 4));
  lcd.latch(rs, nibble(byte));
}

function print(lcd: Hd44780, text: string): void {
  for (const c of text) lcd.execute(true, c.charCodeAt(0));
}

function rowText(lcd: Hd44780, row: number): string {
  const out: number[] = new Array<number>(lcd.cols * lcd.rows);
  lcd.characters(out);
  return String.fromCharCode(...out.slice(row * lcd.cols, (row + 1) * lcd.cols));
}

describe('HD44780', () => {
  it('reads the 0x3/0x3/0x3/0x2 init in 8-bit mode, then pairs nibbles high-first', () => {
    const lcd = new Hd44780(16, 2);
    expect(lcd.eightBit).toBe(true);
    lcd.latch(false, nibble(0x3));
    lcd.latch(false, nibble(0x3));
    lcd.latch(false, nibble(0x3));
    expect(lcd.eightBit).toBe(true);
    lcd.latch(false, nibble(0x2));
    expect(lcd.eightBit).toBe(false);
    expect(lcd.twoLines).toBe(false);
    // The next two transfers are one instruction: 0x28 (4-bit, two lines).
    lcd.latch(false, nibble(0x2));
    expect(lcd.twoLines).toBe(false);
    lcd.latch(false, nibble(0x8));
    expect(lcd.twoLines).toBe(true);
    send4(lcd, false, 0x0c);
    expect(lcd.displayOn).toBe(true);
    send4(lcd, true, 0x41);
    expect(rowText(lcd, 0).startsWith('A ')).toBe(true);
    expect(lcd.ac).toBe(1);
  });

  it('switches back to 8-bit on function set DL=1', () => {
    const lcd = new Hd44780(16, 2);
    init4bit(lcd);
    send4(lcd, false, 0x30);
    expect(lcd.eightBit).toBe(true);
    lcd.latch(true, 0x5a); // one full byte again
    expect(rowText(lcd, 0)[0]).toBe('Z');
  });

  it('places rows at DDRAM 0x00, 0x40, 0x14 and 0x54 on a 20x4', () => {
    const lcd = new Hd44780(20, 4);
    lcd.execute(false, 0x38); // 8-bit, two lines
    const rows = ['first row', 'second row', 'third row', 'fourth row'];
    [0x00, 0x40, 0x14, 0x54].forEach((address, row) => {
      lcd.execute(false, 0x80 | address);
      print(lcd, rows[row]);
    });
    for (let row = 0; row < 4; row++) expect(rowText(lcd, row)).toBe(rows[row].padEnd(20));
    // Writing past the end of row 0 continues on row 2 (the same DDRAM line).
    lcd.execute(false, 0x80 | 0x12);
    print(lcd, 'ABCD');
    expect(rowText(lcd, 0).slice(18)).toBe('AB');
    expect(rowText(lcd, 2).slice(0, 2)).toBe('CD');
  });

  it('wraps the address counter from the end of line 1 to line 2 and back', () => {
    const lcd = new Hd44780(16, 2);
    lcd.execute(false, 0x38);
    lcd.execute(false, 0x80 | 0x27);
    lcd.execute(true, 0x31);
    expect(lcd.ac).toBe(0x40);
    lcd.execute(false, 0x80 | 0x67);
    lcd.execute(true, 0x32);
    expect(lcd.ac).toBe(0x00);
    lcd.execute(false, 0x04); // decrement
    lcd.execute(true, 0x33);
    expect(lcd.ac).toBe(0x67);
  });

  it('shifts the display with entry mode S=1 and with cursor/display shift', () => {
    const lcd = new Hd44780(16, 2);
    lcd.execute(false, 0x38);
    lcd.execute(false, 0x80 | 0x10); // just past the visible 16 columns
    lcd.execute(false, 0x07); // increment + display shift
    print(lcd, 'XYZ');
    // Each write shifted the display one column left: columns 16..18 now show at 13..15.
    expect(lcd.shift).toBe(3);
    expect(rowText(lcd, 0).slice(13)).toBe('XYZ');
    lcd.execute(false, 0x1c); // display shift right
    expect(lcd.shift).toBe(2);
    expect(rowText(lcd, 0).slice(14)).toBe('XY');
    lcd.execute(false, 0x02); // return home also undoes the shift
    expect(lcd.shift).toBe(0);
    lcd.execute(false, 0x14); // cursor right
    expect(lcd.ac).toBe(1);
    expect(lcd.cursorPosition()).toEqual([1, 0]);
  });

  it('writes CGRAM rows and shows them for codes 0–7', () => {
    const lcd = new Hd44780(16, 2);
    lcd.execute(false, 0x38);
    lcd.execute(false, 0x40 | (2 << 3)); // character 2, row 0
    const heart = [0x00, 0x0a, 0x1f, 0x1f, 0x0e, 0x04, 0x00, 0xff];
    for (const row of heart) lcd.execute(true, row);
    expect([...lcd.cgram.slice(16, 24)]).toEqual([0x00, 0x0a, 0x1f, 0x1f, 0x0e, 0x04, 0x00, 0x1f]);
    expect(lcd.ac).toBe(24);
    expect(lcd.cursorPosition()).toEqual([-1, -1]);
    lcd.execute(false, 0x80); // back to DDRAM
    lcd.execute(true, 2);
    expect(rowText(lcd, 0).charCodeAt(0)).toBe(2);
    expect(lcd.cgram[0]).toBe(0);
  });

  it('clears to spaces and resets the entry mode to increment', () => {
    const lcd = new Hd44780(16, 2);
    lcd.execute(false, 0x38);
    lcd.execute(false, 0x04);
    print(lcd, 'hi');
    lcd.execute(false, 0x01);
    expect(rowText(lcd, 0)).toBe(' '.repeat(16));
    expect(lcd.ac).toBe(0);
    expect(lcd.increment).toBe(true);
    lcd.execute(false, 0x0f);
    expect([lcd.displayOn, lcd.cursorOn, lcd.blinkOn]).toEqual([true, true, true]);
  });
});
