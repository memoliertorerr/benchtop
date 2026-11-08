/**
 * BT135: the modules a board can carry — its `module` prop's choices, for the Inspector and the
 * catalog's readers. The MCU factories read the same ids (@benchtop/esp32's ESP32_MODULES,
 * @benchtop/esp32s3's S3_MODULES; boards/modules.test.ts holds them to this table) and give the
 * chip the PSRAM the module has. `auto` lets the build decide, as before the prop existed.
 */

export interface ModuleChoice {
  readonly id: string;
  readonly label: string;
}

export const BOARD_MODULES: Readonly<Record<string, readonly ModuleChoice[]>> = {
  'esp32-devkit-v1': [
    { id: 'auto', label: 'auto — the build decides (PSRAM, flash size)' },
    { id: 'WROOM-32', label: 'ESP32-WROOM-32 — 4 MB flash, no PSRAM' },
    { id: 'WROVER-E', label: 'ESP32-WROVER-E — 4 MB flash, 8 MB PSRAM (GPIO16/17 are its)' },
    { id: 'WROOM-32E-N8', label: 'ESP32-WROOM-32E-N8 — 8 MB flash, no PSRAM' },
    { id: 'WROOM-32E-N16', label: 'ESP32-WROOM-32E-N16 — 16 MB flash, no PSRAM' },
    { id: 'WROVER-E-N16R8', label: 'ESP32-WROVER-E-N16R8 — 16 MB flash, 8 MB PSRAM (GPIO16/17 are its)' },
  ],
  'esp32-s3-devkitc-1': [
    { id: 'auto', label: 'auto — the build decides (PSRAM, flash size)' },
    { id: 'N8', label: 'N8 — 8 MB flash, no PSRAM' },
    { id: 'N8R2', label: 'N8R2 — 8 MB flash, 2 MB quad PSRAM' },
    { id: 'N8R8', label: 'N8R8 — 8 MB flash, 8 MB octal PSRAM (IO35–37 are its)' },
    { id: 'N16R8', label: 'N16R8 — 16 MB flash, 8 MB octal PSRAM (IO35–37 are its)' },
  ],
};
