import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { editorMessage } from '../editor/app-store.ts';
import { importNotes } from '../editor/import-notes.ts';
import { micNotes } from './audio/mic.ts';
import { allCompileRows } from '../editor/sketch-actions.ts';
import { type Problem, PROBLEM_CODES } from '@benchtop/core';
import { simProblems } from '../sim/host.ts';
import { Debugger } from './debug/Debugger.tsx';
import { LogicAnalyzer } from './logic/LogicAnalyzer.tsx';
import { probes } from './logic/probes.ts';
import { showParts } from './problem-actions.ts';
import { SerialMonitor } from './SerialMonitor.tsx';
import { CodePanel } from './code/CodePanel.tsx';
import { drcViolations, viewMode } from '../pcb/mode.ts';
import { lazyComponent } from './lazy.tsx';
import { SerialPlotter } from './plotter/SerialPlotter.tsx';

const TABS = ['Serial', 'Plotter', 'Code', 'Problems', 'Logic analyzer', 'Debugger'] as const;

/** The Code tab is open (the shell gives the panel more height for it). */
export const codeTabOpen = signal(false);
type Tab = (typeof TABS)[number];

const ICONS = { error: '⛔', warning: '⚠️', info: 'ℹ️' } as const;

const RANK = { error: 0, warning: 1, info: 2 } as const;

/** Errors first, then warnings, then infos; stable within a severity. */
function sortProblems(list: readonly Problem[]): Problem[] {
  return [...list].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

function copyLocation(text: string): void {
  const done = () => (editorMessage.value = `Copied ${text}`);
  navigator.clipboard?.writeText(text).then(done, () => (editorMessage.value = text)) ?? (editorMessage.value = text);
}

/** BT59: the PCB's design rule check rows (pcb/DrcRows.tsx), loaded with the PCB view's chunk. */
const DrcRows = lazyComponent(() => import('../pcb/DrcRows.tsx').then((m) => m.DrcRows));

function ProblemsList() {
  const problems = simProblems.value;
  const compile = allCompileRows.value;
  const notes = importNotes.value;
  const mic = micNotes.value;
  const pcbShown = viewMode.value === 'pcb';
  if (!pcbShown && problems.length === 0 && compile.length === 0 && notes.length === 0 && mic.length === 0) return <p class="muted panel-note">No problems. (They appear once the bench has run.)</p>;
  return (
    <ul class="problems">
      {pcbShown && <DrcRows />}
      {mic.map((note, i) => (
        <li key={`mic:${i}`} class="problem warning">
          <span aria-hidden="true">{ICONS.warning}</span>
          <span class="problem-body">
            <span class="problem-title">Microphone</span>
            <span class="problem-message">{note}</span>
          </span>
        </li>
      ))}
      {notes.map((note, i) => (
        <li key={`import:${i}`} class="problem info">
          <span aria-hidden="true">{ICONS.info}</span>
          <span class="problem-body">
            <span class="problem-title">Import</span>
            <span class="problem-message">{note}</span>
          </span>
        </li>
      ))}
      {compile.map((row) => (
        <li key={row.key} class={`problem ${row.severity}`}>
          <span aria-hidden="true">{ICONS[row.severity]}</span>
          {row.location !== '' && (
            <button type="button" class="problem-location" title={`Copy ${row.copy}`} onClick={() => copyLocation(row.copy)}>
              {row.location}
            </button>
          )}
          <span class="problem-message">{row.message}</span>
          <span class="problem-parts">{row.board}</span>
        </li>
      ))}
      {sortProblems(problems).map((p) => (
        <li key={`${p.code}:${p.parts.join(',')}`} class={`problem ${p.severity}${p.parts.length > 0 ? ' clickable' : ''}`}>
          <button type="button" class="problem-row" disabled={p.parts.length === 0} title={p.parts.length > 0 ? 'Select and show these parts' : undefined} onClick={() => showParts(p.parts)}>
            <span aria-hidden="true">{ICONS[p.severity]}</span>
            <span class="problem-body">
              <span class="problem-title">{PROBLEM_CODES[p.code]?.title ?? p.code}</span>
              <span class="problem-message">{p.message}</span>
              {PROBLEM_CODES[p.code] !== undefined && <span class="problem-hint">{PROBLEM_CODES[p.code].hint}</span>}
            </span>
            {p.parts.length > 0 && <span class="problem-parts">{p.parts.join(', ')}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function BottomPanel() {
  const [tab, setTab] = useState<Tab>('Serial');
  const drcCount = viewMode.value === 'pcb' ? drcViolations.value : 0;
  const count = simProblems.value.length + allCompileRows.value.length + importNotes.value.length + micNotes.value.length + drcCount;
  return (
    <section class="bottom-panel" aria-label="Output">
      <div class="tabs" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            class="tab"
            aria-selected={tab === name}
            onClick={() => {
              setTab(name);
              codeTabOpen.value = name === 'Code';
            }}
          >
            {name}
            {name === 'Problems' && count > 0 && <span class="badge">{count}</span>}
            {name === 'Logic analyzer' && probes.value.length > 0 && <span class="badge neutral">{probes.value.length}</span>}
          </button>
        ))}
      </div>
      {tab === 'Serial' && <SerialMonitor />}
      {tab === 'Plotter' && <SerialPlotter />}
      {tab === 'Code' && <CodePanel />}
      {tab === 'Problems' && <ProblemsList />}
      {tab === 'Logic analyzer' && <LogicAnalyzer />}
      {tab === 'Debugger' && <Debugger />}
    </section>
  );
}
