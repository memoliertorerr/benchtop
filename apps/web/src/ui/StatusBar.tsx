import { editor, editorMessage } from '../editor/app-store.ts';
import { simError, simProblems, simStatus } from '../sim/host.ts';
import { audioBehind } from './audio/speakers.ts';

const LABELS = { starting: 'Simulator starting…', ready: 'Simulator ready', error: 'Simulator error' };

export function StatusBar() {
  const status = simStatus.value;
  const parts = editor.doc.value.parts.length;
  return (
    <footer class="status-bar">
      <span class={`status-dot ${status}`} />
      <span>{LABELS[status]}</span>
      {simError.value && <span class="status-error">{simError.value}</span>}
      <span class="status-spacer" />
      {editorMessage.value && <span class="status-message">{editorMessage.value}</span>}
      {audioBehind.value && (
        <span class="status-audio-behind" title="The bench runs below real time, so the speaker's sound has gaps">
          audio behind
        </span>
      )}
      <ProblemCounts />
      <span>
        {parts} {parts === 1 ? 'part' : 'parts'}
      </span>
    </footer>
  );
}

/** Error and warning counts from the worker's problem list (re-renders only when it changes). */
function ProblemCounts() {
  const list = simProblems.value;
  const errors = list.filter((p) => p.severity === 'error').length;
  const warnings = list.filter((p) => p.severity === 'warning').length;
  if (errors === 0 && warnings === 0) return null;
  return (
    <span class="status-problems">
      {errors > 0 && <span class="status-errors">⛔ {errors}</span>}
      {warnings > 0 && <span class="status-warnings">⚠️ {warnings}</span>}
    </span>
  );
}
