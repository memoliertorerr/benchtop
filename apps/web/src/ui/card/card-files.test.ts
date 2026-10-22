import { parseCardFiles, SD_FILES_MAX, utf8Encode } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { baseName, formatSize, powerUpFiles, previewOf, withFiles, withoutFile } from './card-files.ts';

// BT91: the Inspector's power-up files for a microSD card, and file previews.

describe('card files (BT91)', () => {
  it('adds, replaces (whatever the case) and removes power-up files in the prop', () => {
    let prop = withFiles('', [['config.txt', utf8Encode('a=1\n')]]);
    expect(prop).toBe('{"config.txt":"a=1\\n"}');
    prop = withFiles(prop, [
      ['CONFIG.TXT', utf8Encode('a=2\n')],
      ['logo.bin', Uint8Array.of(0, 1, 2, 255)],
    ]);
    expect(powerUpFiles(prop)).toEqual([
      { path: 'CONFIG.TXT', size: 4 },
      { path: 'logo.bin', size: 4 },
    ]);
    expect(parseCardFiles(prop as string).files[1][1]).toEqual(Uint8Array.of(0, 1, 2, 255)); // binary went in as base64
    expect(withoutFile(prop, 'logo.bin')).toBe('{"CONFIG.TXT":"a=2\\n"}');
    expect(withoutFile(withoutFile(prop, 'logo.bin'), 'CONFIG.TXT')).toBe('');
    expect(withFiles(prop, [['big.bin', new Uint8Array(SD_FILES_MAX)]])).toBeNull();
    expect(powerUpFiles(undefined)).toEqual([]);
    expect(powerUpFiles('not json')).toEqual([]);
  });

  it('previews text as text and anything else as a hex dump', () => {
    expect(previewOf(utf8Encode('t,v\r\n1,2\r\n'))).toBe('t,v\r\n1,2\r\n');
    expect(previewOf(utf8Encode('é'.repeat(3000)))).toMatch(/^é{2048}\n… 1,904 more bytes$/);
    const dump = previewOf(Uint8Array.from({ length: 300 }, (_, i) => i & 0xff));
    expect(dump.split('\n')[0]).toBe('0000  00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f  ................');
    expect(dump).toContain('… 44 more bytes');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(32 * 1024)).toBe('32.0 KB');
    expect(baseName('data/run 1/a.csv')).toBe('a.csv');
  });
});
