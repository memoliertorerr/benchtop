/**
 * The PCB view's light state (BT59), loaded with the app: which view the main area shows, a
 * point the PCB view should show, and a reset the toolbar asks for. Everything that needs
 * @benchtop/pcb (the store, the view, the exports) is a separate chunk loaded on first use.
 */

import type { Point } from '@benchtop/pcb';
import { signal } from '@preact/signals';
import { PCB_AUTOSAVE_KEY } from './store-key.ts';

/** The main area: the bench (breadboards, wires, simulation) or its PCB. */
export const viewMode = signal<'bench' | 'pcb'>('bench');

/** How many DRC findings the PCB has (the Problems tab's badge; set by the loaded DRC rows). */
export const drcViolations = signal(0);

/** A board point the PCB view centres on once (set by the Problems tab's DRC rows). */
export const pcbFocus = signal<Point | null>(null);

let resetLoaded: (() => void) | null = null;

/** The loaded PCB store registers its reset here. */
export function onPcbReset(reset: () => void): void {
  resetLoaded = reset;
}

/** Forgets the PCB (New, Open, an example): the next PCB view seeds one for the new bench. */
export function resetPcb(): void {
  try {
    window.localStorage.removeItem(PCB_AUTOSAVE_KEY);
  } catch {
    /* storage blocked */
  }
  resetLoaded?.();
}
