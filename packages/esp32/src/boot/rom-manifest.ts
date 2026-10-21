/**
 * The ESP32 mask ROM Benchtop runs: Espressif's esp-rom-elfs release (Apache-2.0), pinned.
 * `npm run fetch:esp32-rom` downloads the tarball (with a human's approval), requires its
 * SHA-256 to equal BOTH the release's published checksum asset and ROM_TARBALL_SHA256 below,
 * extracts only ROM_ELF_NAME into ROM_CACHE_DIR (git-ignored) and checks ROM_ELF_SHA256.
 * Nothing ROM-derived is ever committed. Rev 0 and rev 1 chips share this ROM (Espressif's
 * README); Benchtop emulates a v1.0 chip.
 */

export const ROM_RELEASE = '20241011';
export const ROM_TARBALL_URL = `https://github.com/espressif/esp-rom-elfs/releases/download/${ROM_RELEASE}/esp-rom-elfs-${ROM_RELEASE}.tar.gz`;
export const ROM_CHECKSUM_URL = `https://github.com/espressif/esp-rom-elfs/releases/download/${ROM_RELEASE}/esp-rom-elfs-${ROM_RELEASE}-checksum.sha256`;
export const ROM_TARBALL_NAME = `esp-rom-elfs-${ROM_RELEASE}.tar.gz`;
/**
 * SHA-256 of the tarball, from `npm run fetch:esp32-rom -- --yes --record` on 2026-10-20; equals
 * the release's published line "921f0001…e9a9 *esp-rom-elfs-20241011.tar.gz".
 */
export const ROM_TARBALL_SHA256 = '921f000164a421c7628fbfee55b173384aafaa51883adc65cd27bf9b0af9e9a9';
export const ROM_ELF_NAME = 'esp32_rev0_rom.elf';
/** SHA-256 of ROM_ELF_NAME as extracted (845,900 bytes). */
export const ROM_ELF_SHA256 = 'bef39889393de40d7ae8dcf1cfe0bba32435a96a0b6ec35839724a9fddd6049f';
/** Relative to the repository root. */
export const ROM_CACHE_DIR = '.cache/esp32-rom';
