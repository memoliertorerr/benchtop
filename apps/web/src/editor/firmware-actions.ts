/**
 * Attaching a firmware file to a board: from a drop on the board or the inspector's button. A
 * `.py` (BT63) becomes the board's MicroPython sketch (main.py), on boards MicroPython runs on.
 */

import { firmwareChanged } from '../sim/controller.ts';
import { editor, editorMessage } from './app-store.ts';
import { firmwareStore, formatOf, MAX_FIRMWARE_BYTES } from './firmware-store.ts';
import { micropythonFqbnOf } from './fqbn.ts';
import { MICROPYTHON_MAIN, storedMicroPython } from './inline-compile.ts';

export async function attachFirmwareFile(board: string, file: File): Promise<void> {
  if (file.size > MAX_FIRMWARE_BYTES) {
    editorMessage.value = `${file.name} is larger than 4 MB; that's not Uno or ESP32 firmware.`;
    return;
  }
  const format = formatOf(file.name);
  if (format === undefined) {
    editorMessage.value = `${file.name}: firmware must be a .hex, .elf, .bin or .uf2 file (or a MicroPython .py for a Pico).`;
    return;
  }
  if (format === 'micropython') {
    const type = editor.doc.peek().parts.find((p) => p.id === board)?.type;
    const fqbn = type === undefined ? undefined : micropythonFqbnOf(type);
    if (fqbn === undefined) {
      editorMessage.value = `${file.name}: MicroPython runs on the Raspberry Pi Pico, not on ${board}.`;
      return;
    }
    const ref = { kind: 'inline' as const, fqbn, files: { [MICROPYTHON_MAIN]: await file.text() }, main: MICROPYTHON_MAIN };
    await firmwareStore.put(board, storedMicroPython(ref));
    editor.setFirmware(board, ref);
    firmwareChanged();
    editorMessage.value = `Loaded ${file.name} into ${board} as its MicroPython main.py (edit it in the Code tab).`;
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await firmwareStore.put(board, { name: file.name, format, bytes });
  editor.setFirmware(board, { kind: 'file', name: file.name, format });
  firmwareChanged();
  editorMessage.value = `Loaded ${file.name} into ${board}.`;
}
