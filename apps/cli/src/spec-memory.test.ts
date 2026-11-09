import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { type RunIo, type RunReport, runHeadless } from './run.ts';
import { parseSpec } from './spec.ts';

// BT156: a spec's `memory` — the boards' EEPROM or flash data a recorded test starts from —
// parsed defensively and put back before the firmware runs; what doesn't fit is a usage error.

const io: RunIo = { readFile: (path) => readFileSync(resolve(REPO_ROOT, path)), now: () => performance.now() };

function counter(memory: unknown): RunReport {
  const spec = parseSpec({ project: 'fixtures/projects/uno-eeprom-counter.json', firmware: { uno: 'fixtures/firmware/uno/eeprom-counter.hex' }, memory, duration: '300ms', expect: [] }, `${REPO_ROOT}/x.bench.json`);
  return runHeadless({ ...spec.options, project: 'fixtures/projects/uno-eeprom-counter.json', firmware: { uno: 'fixtures/firmware/uno/eeprom-counter.hex' } }, io);
}

describe('a spec’s memory (BT156)', () => {
  it('parses sectors at numeric or hex offsets, base64 bytes; refuses anything else naming the field', () => {
    const ok = parseSpec({ project: 'p.json', memory: { uno: [{ offset: '0x100', base64: 'AQI=' }, { offset: 0, base64: '' }] } }, 'x.bench.json');
    expect(ok.options.memory).toEqual({ uno: [{ offset: 256, bytes: Uint8Array.of(1, 2) }, { offset: 0, bytes: new Uint8Array(0) }] });
    const bad: [unknown, RegExp][] = [
      [[], /"memory" must map board ids/],
      [{ uno: {} }, /"memory\.uno" must be an array/],
      [{ uno: [3] }, /"memory\.uno\[0\]" must be an object/],
      [{ uno: [{ offset: 0, base64: 'AQ==', size: 1 }] }, /unknown field "size"/],
      [{ uno: [{ offset: -4, base64: 'AQ==' }] }, /"memory\.uno\[0\]\.offset" must be a byte offset/],
      [{ uno: [{ offset: '9000h', base64: 'AQ==' }] }, /offset" must be a byte offset/],
      [{ uno: [{ offset: 1.5, base64: 'AQ==' }] }, /offset" must be a byte offset/],
      [{ uno: [{ offset: 0, base64: 'A*==' }] }, /"memory\.uno\[0\]\.base64" must be base64/],
      [{ uno: [{ offset: 0, base64: 'AQ=' }] }, /base64" must be base64/],
      [{ uno: [{ offset: 0 }] }, /base64" must be base64/],
    ];
    for (const [memory, message] of bad) expect(() => parseSpec({ project: 'p.json', memory }, 'x.bench.json')).toThrow(message);
  });

  it('puts the data back before the firmware runs: the counter goes on from the stored count', () => {
    const r = counter({ uno: [{ offset: '0x0', base64: 'KQ==' }] });
    expect(r.error).toBeNull();
    expect(r.serial.uno).toContain('boot 42');
    expect(counter(undefined).serial.uno).toContain('boot 1'); // without it, erased as before
  });

  it('a board the project lacks, a sector off the memory, misaligned or too long is a usage error naming it', () => {
    expect(counter({ esp: [] }).error).toMatch(/memory: "esp" isn't a board of the project/);
    expect(counter({ uno: [{ offset: '0x1000', base64: 'AQ==' }] }).error).toMatch(/memory\.uno: 0x1000 isn't the start of a sector of its eeprom \(1024 bytes, 256-byte sectors\)/);
    expect(counter({ uno: [{ offset: 1, base64: 'AQ==' }] }).error).toMatch(/memory\.uno: 0x1 isn't the start of a sector/);
    const tooLong = Buffer.alloc(257, 1).toString('base64');
    expect(counter({ uno: [{ offset: 0, base64: tooLong }] }).error).toMatch(/the sector at 0x0 holds 257 bytes, more than its 256/);
    expect(counter({ uno: [{ offset: 0, base64: 'KQ==' }] }).exitCode).toBe(0);
    expect(counter({ esp: [] }).exitCode).toBe(2);
  });
});
