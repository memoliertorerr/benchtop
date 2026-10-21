/** Attaching a firmware file to a board: from a drop on the board or the inspector's button. */

import { firmwareChanged } from '../sim/controller.ts';
import { editor, editorMessage } from './app-store.ts';
import { firmwareStore, formatOf, MAX_FIRMWARE_BYTES } from './firmware-store.ts';

export async function attachFirmwareFile(board: string, file: File): Promise<void> {
  if (file.size > MAX_FIRMWARE_BYTES) {
    editorMessage.value = `${file.name} is larger than 4 MB; that's not Uno or ESP32 firmware.`;
    return;
  }
  const format = formatOf(file.name);
  if (format === undefined) {
    editorMessage.value = `${file.name}: firmware must be a .hex, .elf or .bin file.`;
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await firmwareStore.put(board, { name: file.name, format, bytes });
  editor.setFirmware(board, { kind: 'file', name: file.name, format });
  firmwareChanged();
  editorMessage.value = `Loaded ${file.name} into ${board}.`;
}
