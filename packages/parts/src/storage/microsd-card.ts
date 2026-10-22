/**
 * microSD card module (BT89): a socket breakout with CS, SCK, DI (MOSI), DO (MISO), VCC, GND and
 * CD, holding an 8 GB SDHC card (sd-card.ts) over a sparse block store. Each build of the model
 * is a power-up: the card is formatted FAT32 (label BENCHTOP) and gets the files of the `files`
 * prop — a JSON object, path → text, or `{ "b64": "…" }` for binary, 256 KB at most. A bench
 * reset only resets the card's SPI state: what firmware wrote stays, as on a real card.
 *
 * `inserted` (prop: at power-up; a `value` input while running, 1 in, 0 out) empties the socket:
 * the card stops answering (MISO reads 0xFF) and loses power, so it needs CMD0 again. CD follows
 * the common breakout (Adafruit's): shorted to ground while a card is in, open otherwise — read it
 * with INPUT_PULLUP. DO rests high through the module's pull-up. The model carries `storage` (core's PartStorage) so the bench, the UI, the
 * MCP server and specs can list, read and write the card's files. Pins from @wokwi/elements 1.9.2
 * microsd-card-element.
 */

import { type PartContext, type PartInput, type PartModel, type PartStorage, type StoredFile, Strength, type VisualState } from '@benchtop/core';
import { MM_PER_PX } from '../categories.ts';
import { definePart } from '../define.ts';
import { SparseBlocks } from './blocks.ts';
import { FatVolume, formatFat32 } from './fat.ts';
import { SD_BLOCKS, SdCard } from './sd-card.ts';
import { base64Decode, base64Encode, utf8Encode, utf8Text } from './text.ts';

/** Most bytes the `files` prop may put on the card. */
export const SD_FILES_MAX = 256 * 1024;

type MicrosdProps = { files: string; inserted: boolean };

/** The `files` prop as [path, bytes] pairs, and what was wrong with it (for the Problems panel). */
export function parseCardFiles(text: string): { files: [string, Uint8Array][]; error: string | null } {
  const files: [string, Uint8Array][] = [];
  if (text.trim() === '') return { files, error: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { files, error: 'it is not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { files, error: 'it is not an object of path → contents' };
  let total = 0;
  for (const [path, content] of Object.entries(value)) {
    let bytes: Uint8Array | null = null;
    if (typeof content === 'string') bytes = utf8Encode(content);
    else if (typeof content === 'object' && content !== null && typeof (content as { b64?: unknown }).b64 === 'string') bytes = base64Decode((content as { b64: string }).b64);
    if (bytes === null) return { files, error: `"${path}" is neither text nor { "b64": … }` };
    total += bytes.length;
    if (total > SD_FILES_MAX) return { files, error: `the files hold more than ${SD_FILES_MAX / 1024} KB` };
    files.push([path, bytes]);
  }
  return { files, error: null };
}

/** The `files` prop holding `files`: UTF-8 text as text, anything else as base64. */
export function cardFilesProp(files: readonly (readonly [string, Uint8Array])[]): string {
  const out: Record<string, string | { b64: string }> = {};
  for (const [path, bytes] of files) {
    const text = utf8Text(bytes);
    out[path] = text !== null ? text : { b64: base64Encode(bytes) };
  }
  return files.length === 0 ? '' : JSON.stringify(out);
}

/** The card's files through the FAT library (mounted afresh each call: firmware may have changed them). */
class CardStorage implements PartStorage {
  version = 0;
  private readonly blocks: SparseBlocks;

  constructor(blocks: SparseBlocks) {
    this.blocks = blocks;
  }

  list(): StoredFile[] {
    return FatVolume.mount(this.blocks)?.list() ?? [];
  }

  read(path: string): Uint8Array | undefined {
    return FatVolume.mount(this.blocks)?.read(path);
  }

  write(path: string, bytes: Uint8Array): boolean {
    const ok = FatVolume.mount(this.blocks)?.write(path, bytes) ?? false;
    if (ok) this.version++;
    return ok;
  }

  remove(path: string): boolean {
    const ok = FatVolume.mount(this.blocks)?.remove(path) ?? false;
    if (ok) this.version++;
    return ok;
  }
}

class MicrosdModel implements PartModel {
  readonly storage: CardStorage;
  private readonly ctx: PartContext;
  private readonly card: SdCard;
  private readonly cd: ReturnType<PartContext['pin']>;
  private readonly state: { inserted: boolean; writes: number } = { inserted: true, writes: 0 };

  constructor(ctx: PartContext, props: MicrosdProps) {
    this.ctx = ctx;
    const blocks = new SparseBlocks(SD_BLOCKS);
    formatFat32(blocks, { label: 'BENCHTOP' });
    this.storage = new CardStorage(blocks);
    const { files, error } = parseCardFiles(props.files);
    const volume = FatVolume.mount(blocks);
    const failed = files.filter(([path, bytes]) => volume?.write(path, bytes) !== true).map(([path]) => path);
    const why = error !== null ? `its files couldn't all be read: ${error}` : failed.length > 0 ? `${failed.join(', ')} couldn't be written (a bad name, or a file where a directory should be)` : '';
    if (why !== '') ctx.report({ severity: 'warning', code: 'sd-card-files', message: `The microSD card starts without some files: ${why}.`, parts: [] });

    this.card = new SdCard(blocks, () => ctx.now());
    this.card.onWrite = () => {
      this.storage.version++;
      this.state.writes = this.card.writes;
      ctx.invalidate();
    };
    ctx.attachSpi({ sck: 'SCK', mosi: 'DI', miso: 'DO', cs: 'CS' }, this.card);
    ctx.pin('CS').onChange((state) => {
      if (state.level !== 0) this.card.deselect();
    });
    this.cd = ctx.pin('CD');
    // DO's pull-up (the SD spec asks for one on DAT0; breakouts carry 10 kΩ): bytes go through
    // the SPI transaction, so the pin only rests high, as MISO does between transfers.
    ctx.pin('DO').drive(1, Strength.weak);
    this.setInserted(props.inserted);
  }

  input(event: PartInput): void {
    if (event.kind === 'value') this.setInserted(event.value >= 0.5);
  }

  visual(): VisualState {
    return this.state;
  }

  reset(): void {
    this.card.powerOn();
  }

  private setInserted(inserted: boolean): void {
    if (inserted && !this.card.inserted) this.card.powerOn();
    this.card.inserted = inserted;
    this.state.inserted = inserted;
    if (inserted) this.cd.drive(0, Strength.strong);
    else this.cd.release();
    this.ctx.invalidate();
  }
}

const PIN_INFO: readonly (readonly [string, number, number])[] = [
  ['CD', 76.734, 9.3744],
  ['DO', 76.734, 18.8622],
  ['GND', 76.734, 28.4634],
  ['SCK', 76.734, 38.178],
  ['VCC', 76.734, 47.628],
  ['DI', 76.734, 57.456],
  ['CS', 76.734, 66.906],
];

const ROLES: Record<string, 'digital' | 'power' | 'ground'> = { GND: 'ground', VCC: 'power' };

export const microsdCard = definePart({
  type: 'microsd-card',
  title: 'microSD card module',
  category: 'storage',
  size: { w: 21.6, h: 20.4 },
  pins: PIN_INFO.map(([name, x, y]) => ({ name, x: x * MM_PER_PX, y: y * MM_PER_PX, role: ROLES[name] ?? ('digital' as const) })),
  defaults: { files: '', inserted: true },
  createModel: (ctx, props) => new MicrosdModel(ctx, props),
});
