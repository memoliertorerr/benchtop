/**
 * After "Stop" (BT50): what was recorded, the expectations proposed from where it ended (all
 * ticked), a name and each board's firmware path — relative to where the spec will be saved —
 * then "Download spec" saves `<name>.bench.json` for `npm run bench -- test`.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { editorMessage } from '../editor/app-store.ts';
import { defaultFirmwarePaths, specFileName, specText } from '../editor/test-spec.ts';
import { loadedProject } from '../sim/controller.ts';
import { simRecorded } from '../sim/host.ts';

function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const seconds = (ns: number): string => `${+(ns / 1e9).toFixed(3)} s`;

export function RecordDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const test = simRecorded.value;
  const doc = loadedProject();
  const [name, setName] = useState('');
  const [firmware, setFirmware] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<boolean[]>([]);

  useEffect(() => {
    const el = dialog.current;
    if (el === null) return;
    if (test !== null && doc !== null) {
      setName(`${doc.name} test`);
      setFirmware(defaultFirmwarePaths(doc));
      setChosen(test.proposals.map(() => true));
      if (!el.open) el.showModal();
    } else if (el.open) el.close();
  }, [test]);

  const close = (): void => {
    simRecorded.value = null;
  };
  if (test === null || doc === null) return <dialog ref={dialog} class="sheet record-dialog" />;
  const expectations = test.proposals.filter((_, i) => chosen[i] !== false);
  const save = (): void => {
    const file = specFileName(name);
    download(specText({ name: name.trim() === '' ? 'recorded test' : name.trim(), doc, firmware, test, expectations }), file);
    editorMessage.value = `Saved ${file} — run it with npm run bench -- test ${file}`;
    close();
  };
  return (
    <dialog ref={dialog} class="sheet record-dialog" aria-label="Recorded test" onClose={close}>
      <header class="gallery-header">
        <h2>Recorded test</h2>
        <span class="toolbar-spacer" />
        <button type="button" class="tool-button" onClick={close}>
          Discard
        </button>
        <button type="button" class="tool-button primary" onClick={save}>
          Download spec
        </button>
      </header>
      <div class="record-body">
        <p class="muted">
          {test.steps.length} input{test.steps.length === 1 ? '' : 's'} over {seconds(test.durationNs)}, replayed at the same instants by{' '}
          <code>npm run bench -- test</code>.
          {test.dropped > 0 ? ` ${test.dropped} inputs past the limit weren't kept.` : ''}
        </p>
        <label class="record-field">
          <span>Name</span>
          <input type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        {Object.entries(firmware).map(([board, path]) => (
          <label key={board} class="record-field">
            <span>
              Firmware for <code>{board}</code>
            </span>
            <input
              type="text"
              value={path}
              title="Path to the compiled firmware (.hex, .elf or .bin), relative to where you save the spec"
              onInput={(e) => setFirmware({ ...firmware, [board]: (e.target as HTMLInputElement).value })}
            />
          </label>
        ))}
        <h3>Expect at the end</h3>
        {test.proposals.length === 0 ? (
          <p class="muted">Nothing to propose: no serial lines, lit LEDs, LCD text or servos. Add expectations to the file by hand.</p>
        ) : (
          <ul class="record-proposals">
            {test.proposals.map((p, i) => (
              <li key={p}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen[i] !== false}
                    onChange={(e) => setChosen(chosen.map((c, j) => (j === i ? (e.target as HTMLInputElement).checked : c)))}
                  />
                  <code>{p}</code>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  );
}
