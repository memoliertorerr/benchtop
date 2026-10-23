/**
 * The ESP32-C3 mask ROM Benchtop runs (BT92): `esp32c3_rev3_rom.elf` from the same pinned
 * esp-rom-elfs release as the ESP32's (Apache-2.0; @benchtop/esp32's rom-manifest.ts pins the
 * tarball). `npm run fetch:esp32-rom` extracts it next to the ESP32 ROM's step: from the cached
 * tarball when there is one (no download), else from the one it downloads after a human
 * approves. Rev 3 (ECO3) is the ROM Arduino-ESP32 2.0.17 links against (its sdkconfig sets
 * CONFIG_ESP32C3_REV_MIN_3, so the app uses esp32c3.rom.eco3.ld). Never committed.
 */

export const C3_ROM_ELF_NAME = 'esp32c3_rev3_rom.elf';
/** SHA-256 of C3_ROM_ELF_NAME as extracted from esp-rom-elfs-20241011.tar.gz (556,332 bytes). */
export const C3_ROM_ELF_SHA256 = '19ac22e08707df926fb0cf4c54795d4067b983fae8635f396ded173a6d78fc3c';
/** Relative to the repository root. */
export const C3_ROM_CACHE_DIR = '.cache/esp32c3-rom';
