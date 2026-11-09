/**
 * The ESP32-S2 mask ROM Benchtop runs (BT148): `esp32s2_rev0_rom.elf` from the same pinned
 * esp-rom-elfs release as the ESP32's (Apache-2.0; @benchtop/esp32's rom-manifest.ts pins the
 * tarball). `npm run fetch:esp32-rom` extracts it with the C3's and the S3's: from the cached
 * tarball when there is one (no download), else from the one it downloads after a human approves.
 * Rev 0 is the only S2 ROM in the release; Arduino-ESP32 2.0.17 links against it. Never committed.
 */

export const S2_ROM_ELF_NAME = 'esp32s2_rev0_rom.elf';
/** SHA-256 of S2_ROM_ELF_NAME as extracted from esp-rom-elfs-20241011.tar.gz (292,128 bytes). */
export const S2_ROM_ELF_SHA256 = 'cabae5c901fe816aea5e74fbb621ad6479ad1b399d6e7212295191559654572d';
/** Relative to the repository root. */
export const S2_ROM_CACHE_DIR = '.cache/esp32s2-rom';
