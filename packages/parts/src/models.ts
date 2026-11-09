/**
 * BT167: the `model` prop's choices per part type (the Inspector shows them as a list): a part
 * whose behavior follows a datasheet part number.
 */

export interface ModelChoice {
  readonly id: string;
  readonly label: string;
}

export const PART_MODELS: Readonly<Record<string, readonly ModelChoice[]>> = {
  diode: [
    { id: '1N4148', label: '1N4148 — small-signal, 0.65 V at 10 mA' },
    { id: '1N4007', label: '1N4007 — 1 A rectifier, 0.95 V at 1 A' },
  ],
  // BT169: transistors (packages/parts basic/transistors.ts has their numbers).
  'npn-transistor': [
    { id: '2N2222A', label: '2N2222A — β 150, 600 mA' },
    { id: 'BC547', label: 'BC547 — β 200, 100 mA (its own legs run C-B-E)' },
  ],
  'pnp-transistor': [
    { id: '2N3906', label: '2N3906 — β 150, 200 mA' },
    { id: 'BC557', label: 'BC557 — β 200, 100 mA (its own legs run C-B-E)' },
  ],
  'n-mosfet': [
    { id: 'IRLZ44N', label: 'IRLZ44N — logic level: fully on from 5 V, well on from 3.3 V' },
    { id: 'IRF540N', label: 'IRF540N — needs 10 V on its gate; barely on from 3.3 V' },
  ],
  'p-mosfet': [{ id: 'IRF9540N', label: 'IRF9540N — on with its gate 10 V below its source' }],
};
