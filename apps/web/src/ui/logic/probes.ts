/**
 * Logic analyzer state on the UI side. Probes are UI state, not part of the project document (a
 * frozen contract): their list is saved next to the autosave (localStorage) and sent to the
 * worker, which keeps recording them across reloads. Each frame's new edges land in a client
 * ring per probe (the same ProbeRing as the worker's); the analyzer canvas listens for changes
 * instead of re-rendering Preact per frame.
 */

import { type PinRef, ProbeRing, type VcdSignal } from '@benchtop/core';
import { edgeAt } from './decimate.ts';
import { effect, signal } from '@preact/signals';
import { onFrame, sim, simStatus, simTime } from '../../sim/host.ts';

export interface ProbeDef {
  key: string;
  pin: PinRef;
  color: string;
}

export interface Capture {
  ring: ProbeRing;
  peripheral: boolean;
  lost: number;
}

const PALETTE = ['#2fbf86', '#e5c12a', '#4aa8ff', '#e9842c', '#c45ad8', '#ff6b6b', '#7fd8cf', '#ecebe6', '#9ccc65', '#ffb74d', '#90a4ae', '#f06292', '#4dd0e1', '#ba68c8', '#aed581', '#ffd54f'];
const STORAGE_KEY = 'benchtop:probes:v1';

export const probeKey = (pin: PinRef): string => `${pin.part}:${pin.pin}`;

function readStored(): ProbeDef[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter((p): p is ProbeDef => typeof p?.key === 'string' && typeof p?.pin?.part === 'string' && typeof p?.pin?.pin === 'string' && typeof p?.color === 'string')
      .slice(0, 16);
  } catch {
    return [];
  }
}

export const probes = signal<readonly ProbeDef[]>(readStored());
/** The Probe tool: clicking a pin probes it instead of starting a wire. */
export const probeMode = signal(false);
export const captures = new Map<string, Capture>();
/** Latest simulated time seen in a frame, ns. */
export let latestTime = 0;

const listeners = new Set<() => void>();
/** Called whenever captured data changes (for the analyzer canvas). */
export function onCapture(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const notify = (): void => {
  for (const listener of listeners) listener();
};

export function toggleProbe(pin: PinRef): void {
  const key = probeKey(pin);
  const list = probes.peek();
  if (list.some((p) => p.key === key)) {
    removeProbe(key);
    return;
  }
  if (list.length >= 16) return;
  const used = new Set(list.map((p) => p.color));
  const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[list.length % PALETTE.length];
  probes.value = [...list, { key, pin: { part: pin.part, pin: pin.pin }, color }];
}

export function removeProbe(key: string): void {
  probes.value = probes.peek().filter((p) => p.key !== key);
  captures.delete(key);
  notify();
}

/** Clears every captured edge (the probes stay). */
export function clearCaptures(): void {
  for (const capture of captures.values()) {
    capture.ring.clear();
    capture.lost = 0;
  }
  notify();
}

// Save the list, and keep the worker's set equal to it.
let sent = new Set<string>();
effect(() => {
  const list = probes.value;
  const ready = simStatus.value === 'ready';
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage blocked: the probes live for the session
  }
  if (!ready) {
    sent = new Set();
    return;
  }
  const keys = new Set(list.map((p) => p.key));
  for (const key of sent) if (!keys.has(key)) sim.removeProbe(key);
  for (const p of list) if (!sent.has(p.key)) sim.addProbe(p.key, p.pin);
  sent = keys;
});

onFrame((frame) => {
  latestTime = frame.t;
  let changed = false;
  for (const chunk of frame.probes) {
    // A frame already in flight can still carry a probe the user just removed.
    if (!probes.peek().some((p) => p.key === chunk.key)) continue;
    let capture = captures.get(chunk.key);
    if (capture === undefined) captures.set(chunk.key, (capture = { ring: new ProbeRing(), peripheral: false, lost: 0 }));
    if (chunk.restart) {
      capture.ring.clear();
      capture.lost = 0;
    }
    for (let i = 0; i < chunk.times.length; i++) capture.ring.push(chunk.times[i], chunk.levels[i]);
    capture.lost += chunk.lost;
    capture.peripheral = chunk.peripheral;
    changed = true;
  }
  if (changed || frame.running) notify();
});

// Keep `latestTime` moving with pauses and steps too.
effect(() => {
  latestTime = simTime.value;
});

/**
 * The captures as VCD signals over the window every probe still holds (a ring that overflowed
 * starts later): each signal's level at the window start, then its edges after it.
 */
export function vcdSignals(): VcdSignal[] {
  const held = probes.peek().flatMap((p) => {
    const capture = captures.get(p.key);
    return capture === undefined || capture.ring.size === 0 ? [] : [{ name: p.key, ring: capture.ring }];
  });
  let start = 0;
  for (const { ring } of held) start = Math.max(start, ring.timeAt(ring.first));
  return held.map(({ name, ring }) => {
    const from = edgeAt(ring, start);
    const read = ring.read(from);
    read.times[0] = start;
    return { name, times: read.times, levels: read.levels };
  });
}
