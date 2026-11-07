/**
 * The ESP32-S3 mask ROM Benchtop runs (BT124): `esp32s3_rev0_rom.elf` from the same pinned
 * esp-rom-elfs release as the ESP32's (Apache-2.0; @benchtop/esp32's rom-manifest.ts pins the
 * tarball). `npm run fetch:esp32-rom` extracts it with the C3's: from the cached tarball when there
 * is one (no download), else from the one it downloads after a human approves. Rev 0 is the only
 * S3 ROM in the release; Arduino-ESP32 2.0.17 links against it. Never committed.
 */

export const S3_ROM_ELF_NAME = 'esp32s3_rev0_rom.elf';
/** SHA-256 of S3_ROM_ELF_NAME as extracted from esp-rom-elfs-20241011.tar.gz (949,552 bytes). */
export const S3_ROM_ELF_SHA256 = 'c0ce0f338d1de1bdc6efbef1591779a2a42c1ab7d759d3c6ae8ae63a7dd34cfd';
/** Relative to the repository root. */
export const S3_ROM_CACHE_DIR = '.cache/esp32s3-rom';
