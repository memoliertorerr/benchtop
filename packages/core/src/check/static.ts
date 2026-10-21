/**
 * Static circuit checks: run when the bench is built (on every topology or prop change), from
 * the project, the part definitions and the netlist only.
 * - esp32-overvoltage (error): a board header pin whose net holds a supply above the MCU's
 *   maximum input voltage (≥ 4.5 V on an ESP32's 3.3 V logic).
 * - unpowered-part (warning): a part whose power pins, or whose ground pins, are all unconnected
 *   (a module with both 3V3 and VIN needs only one).
 * - unconnected-pins (info): one per wired part, listing its unconnected digital and analog
 *   pins; a part with no connection at all gets one 'unwired-part' info and nothing else.
 * Boards and breadboards are skipped (their pins are sources or holes).
 */

import type { BoardSpec, PartDefinition, Problem } from '../contracts/part.ts';
import type { ProjectDoc } from '../contracts/project.ts';
import type { Netlist } from '../netlist/netlist.ts';

/** Highest voltage an MCU's GPIO accepts, by kind. */
export const MAX_INPUT_VOLTS: Readonly<Record<BoardSpec['mcu'], number>> = { atmega328p: 5.5, atmega2560: 5.5, esp32: 3.6 };

export interface StaticCheckInput {
  doc: ProjectDoc;
  defOf: (type: string) => PartDefinition | undefined;
  netlist: Netlist;
  /** Supply voltage fixed on a net, or undefined. */
  supplyVolts: (net: number) => number | undefined;
}

const isBreadboard = (type: string): boolean => type.startsWith('breadboard');

export function staticProblems({ doc, defOf, netlist, supplyVolts }: StaticCheckInput): Problem[] {
  const problems: Problem[] = [];
  const connected = (part: string, pin: string): boolean => {
    const net = netlist.netOf(part, pin);
    return net >= 0 && netlist.pinsOfNet(net).length > 1;
  };

  for (const part of doc.parts) {
    const def = defOf(part.type);
    if (def === undefined) continue;
    const board = def.board;
    if (board !== undefined) {
      for (const header of Object.keys(board.pinMap)) {
        const net = netlist.netOf(part.id, header);
        const volts = net < 0 ? undefined : supplyVolts(net);
        if (volts === undefined || volts <= MAX_INPUT_VOLTS[board.mcu] || board.mcu !== 'esp32') continue;
        const sources = netlist.pinsOfNet(net).filter((p) => p.part !== part.id);
        problems.push({
          severity: 'error',
          code: 'esp32-overvoltage',
          message: `${part.id}:${header} is wired to ${volts} V (${sources.map((p) => `${p.part}:${p.pin}`).join(', ')}); ESP32 pins take at most ${MAX_INPUT_VOLTS.esp32} V.`,
          parts: [part.id, ...new Set(sources.map((p) => p.part))],
        });
      }
      continue;
    }
    if (isBreadboard(part.type)) continue;

    // A part without pins (an IR remote) has nothing to wire.
    if (def.pins.length > 0 && !def.pins.some((pin) => connected(part.id, pin.name))) {
      problems.push({ severity: 'info', code: 'unwired-part', message: `${part.id} has no connections.`, parts: [part.id] });
      continue;
    }
    const power = def.pins.filter((pin) => pin.role === 'power' && pin.volts === undefined);
    const ground = def.pins.filter((pin) => pin.role === 'ground' && pin.volts === undefined);
    const missing = [
      ...(power.length > 0 && !power.some((pin) => connected(part.id, pin.name)) ? [power.map((p) => p.name).join('/')] : []),
      ...(ground.length > 0 && !ground.some((pin) => connected(part.id, pin.name)) ? [ground.map((p) => p.name).join('/')] : []),
    ];
    if (missing.length > 0) {
      problems.push({ severity: 'warning', code: 'unpowered-part', message: `${part.id} has no connection on ${missing.join(' and ')}.`, parts: [part.id] });
    }
    const unused = def.pins.filter((pin) => (pin.role === 'digital' || pin.role === 'analog') && !connected(part.id, pin.name)).map((pin) => pin.name);
    if (unused.length > 0) {
      problems.push({ severity: 'info', code: 'unconnected-pins', message: `${part.id}: ${unused.join(', ')} not connected.`, parts: [part.id] });
    }
  }
  return problems;
}
