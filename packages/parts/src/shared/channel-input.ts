/**
 * Inputs with more than one value (a joystick's x and y). `PartInput` has no channel field and
 * the contracts are frozen, so a channel value travels as a key event:
 * `{ kind: 'key', key: 'set:<channel>=<number>', down: true }`. Single-value parts use
 * `{ kind: 'value', value }`. (Deferred follow-up: PartInput needs a channel field.)
 */

import type { PartInput } from '@benchtop/core';

const PATTERN = /^set:([a-z][a-z0-9_-]*)=(.+)$/;

export function channelInput(channel: string, value: number): PartInput {
  return { kind: 'key', key: `set:${channel}=${value}`, down: true };
}

/** The channel and value of a channel input, or null for any other input. */
export function readChannelInput(event: PartInput): { channel: string; value: number } | null {
  if (event.kind !== 'key' || !event.down) return null;
  const match = PATTERN.exec(event.key);
  if (match === null) return null;
  const value = Number(match[2]);
  return Number.isFinite(value) ? { channel: match[1], value } : null;
}
