import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { inputTargets } from './ir-remote.ts';

describe('IR remote input routing (BT52)', () => {
  it("sends a remote's keys to every IR receiver, anything else's to itself", () => {
    const doc = {
      parts: [
        { id: 'remote', type: 'ir-remote' },
        { id: 'ir1', type: 'ir-receiver' },
        { id: 'btn', type: 'pushbutton' },
        { id: 'ir2', type: 'ir-receiver' },
      ],
    } as unknown as ProjectDoc;
    expect(inputTargets(doc, 'remote')).toEqual(['ir1', 'ir2']);
    expect(inputTargets(doc, 'btn')).toEqual(['btn']);
    expect(inputTargets({ ...doc, parts: [doc.parts[0]] }, 'remote')).toEqual([]);
  });
});
