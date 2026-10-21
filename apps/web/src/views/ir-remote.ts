/**
 * An IR remote has no wires (BT52): its keys reach every IR receiver on the bench, as light would.
 * The canvas sends a remote's input to these parts instead of to the remote itself.
 */

import type { ProjectDoc } from '@benchtop/core';

/** Where a part's input goes: an IR remote's to every ir-receiver, anything else's to itself. */
export function inputTargets(doc: ProjectDoc, partId: string): string[] {
  const part = doc.parts.find((p) => p.id === partId);
  if (part?.type !== 'ir-remote') return [partId];
  return doc.parts.filter((p) => p.type === 'ir-receiver').map((p) => p.id);
}
