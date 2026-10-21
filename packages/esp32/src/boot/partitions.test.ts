import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { appPartition, DEFAULT_PARTITIONS, parsePartitionTable } from './partitions.ts';

describe('parsePartitionTable', () => {
  it('reads the fixtures’ table, which DEFAULT_PARTITIONS holds, with its MD5 checked', () => {
    for (const name of ['serial-hello', 'blink', 'crc-bench']) {
      expect(parsePartitionTable(readFixture(`fixtures/firmware/esp32/${name}.partitions.bin`))).toEqual({ ok: true, table: DEFAULT_PARTITIONS });
    }
    expect(appPartition(DEFAULT_PARTITIONS)).toMatchObject({ label: 'app0', offset: 0x10000, size: 0x140000 });
  });

  it('rejects a changed entry (MD5) and a bad magic', () => {
    const bytes = readFixture('fixtures/firmware/esp32/serial-hello.partitions.bin').slice();
    bytes[4] ^= 1;
    expect(parsePartitionTable(bytes)).toMatchObject({ ok: false, error: expect.stringMatching(/MD5/) });
    const magic = readFixture('fixtures/firmware/esp32/serial-hello.partitions.bin').slice();
    magic[32] = 0x12;
    expect(parsePartitionTable(magic)).toMatchObject({ ok: false, error: expect.stringMatching(/magic/) });
    expect(parsePartitionTable(new Uint8Array(64).fill(0xff))).toMatchObject({ ok: false });
  });
});
