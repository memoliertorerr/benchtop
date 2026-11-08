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
    { id: 'auto', label: 'auto — PSRAM if the build asks for it' },
    { id: 'WROOM-32', label: 'ESP32-WROOM-32 — no PSRAM' },
    { id: 'WROVER-E', label: 'ESP32-WROVER-E — 8 MB PSRAM (GPIO16/17 are its)' },
  ],
  'esp32-s3-devkitc-1': [
    { id: 'auto', label: 'auto — PSRAM if the build asks for it' },
    { id: 'N8', label: 'N8 — no PSRAM' },
    { id: 'N8R2', label: 'N8R2 — 2 MB quad PSRAM' },
    { id: 'N8R8', label: 'N8R8 — 8 MB octal PSRAM' },
  ],
};
