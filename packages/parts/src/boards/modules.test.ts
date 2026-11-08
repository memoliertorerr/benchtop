import { ESP32_MODULES } from '@benchtop/esp32';
import { S3_MODULES } from '@benchtop/esp32s3';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../catalog.ts';
import { BOARD_MODULES } from './modules.ts';

// BT135: the Inspector's module choices are the ids the MCU factories read, and each board's
// default is auto.

describe('board modules (BT135)', () => {
  it('the ESP32 DevKit V1 and the S3 DevKitC-1 offer exactly their factories\u2019 modules, auto by default', () => {
    expect(BOARD_MODULES['esp32-devkit-v1'].map((m) => m.id)).toEqual([...ESP32_MODULES]);
    expect(BOARD_MODULES['esp32-s3-devkitc-1'].map((m) => m.id)).toEqual(Object.keys(S3_MODULES));
    for (const type of Object.keys(BOARD_MODULES)) {
      const def = CATALOG.get(type);
      expect(def?.defaults.module).toBe('auto');
    }
  });
});
