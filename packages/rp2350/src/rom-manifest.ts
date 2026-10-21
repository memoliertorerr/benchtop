/**
 * The RP2350 bootrom Benchtop runs (BT65, human-approved 2026-10-21): Raspberry Pi's
 * pico-bootrom-rp2350 release A4 (BSD-3-Clause), pinned. `npm run fetch:rp2350-rom` downloads
 * the assets below (with a human's approval) into ROM_CACHE_DIR (git-ignored) and requires each
 * one's size and SHA-256 to equal the pinned values — which are the digests GitHub publishes for
 * the release's assets (read 2026-10-21). Nothing ROM-derived is ever committed.
 *
 * bootrom-combined.bin is the 32 KB mask ROM image (Arm and RISC-V code, as at 0x00000000 on the
 * chip); riscv-bootrom.elf has the RISC-V half's symbols (traces and tests name ROM functions).
 */

export const ROM_RELEASE = 'A4';
/** Relative to the repository root. */
export const ROM_CACHE_DIR = '.cache/rp2350-rom';

export interface RomAsset {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

const asset = (name: string, bytes: number, sha256: string): RomAsset => ({
  name,
  url: `https://github.com/raspberrypi/pico-bootrom-rp2350/releases/download/${ROM_RELEASE}/${name}`,
  bytes,
  sha256,
});

export const ROM_IMAGE = asset('bootrom-combined.bin', 32_768, 'c5f9c48c6539f043c423344a53ceaea3774dd1e4c337af49da741a5d259c84bc');
export const ROM_RISCV_ELF = asset('riscv-bootrom.elf', 77_128, '010df88f0381cc04601fce56e6004e651cc88bc979669af1e47abc95c2656295');
export const ROM_ASSETS: readonly RomAsset[] = [ROM_IMAGE, ROM_RISCV_ELF];
