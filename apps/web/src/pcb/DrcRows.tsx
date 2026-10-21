/** BT59: the PCB's design rule check as Problems rows, while the PCB view is shown; a click shows the spot. */

import { pcbCheck } from './app-pcb.ts';
import { pcbFocus } from './mode.ts';

const ICONS = { error: '⛔', warning: '⚠️', info: 'ℹ️' } as const;

export function DrcRows() {
  const check = pcbCheck.value;
  if (check === null) return null;
  if (check.result.violations.length === 0) {
    return (
      <li class="problem info">
        <span aria-hidden="true">✅</span>
        <span class="problem-body">
          <span class="problem-title">PCB design rules</span>
          <span class="problem-message">DRC clean: every net routed, nothing too close.</span>
        </span>
      </li>
    );
  }
  return (
    <>
      {check.result.violations.map((v, i) => (
        <li key={`drc:${i}`} class={`problem ${v.severity} clickable`}>
          <button type="button" class="problem-row" title="Show this on the board" onClick={() => (pcbFocus.value = { ...v.at })}>
            <span aria-hidden="true">{ICONS[v.severity]}</span>
            <span class="problem-body">
              <span class="problem-title">PCB: {v.code.replace(/-/g, ' ')}</span>
              <span class="problem-message">{v.message}</span>
            </span>
            {v.items.length > 0 && <span class="problem-parts">{v.items.slice(0, 3).join(', ')}</span>}
          </button>
        </li>
      ))}
    </>
  );
}

