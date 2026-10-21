/**
 * The serial monitor: one tab per board, the newest ~1 MB of output, autoscroll that pauses
 * while you read further up, optional timestamps (simulated time), clear, and an input line
 * with a line-ending choice. New output is appended as DOM nodes; the buffer is never
 * re-rendered as a whole.
 */

import { CATALOG } from '@benchtop/parts';
import { effect } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../editor/app-store.ts';
import { sim } from '../sim/host.ts';
import { serialBuffer, serialVersion } from './serial-state.ts';

const ENDINGS = { none: '', lf: '\n', crlf: '\r\n' } as const;
type Ending = keyof typeof ENDINGS;

export function SerialMonitor() {
  const boards = editor.doc.value.parts.filter((p) => CATALOG.get(p.type)?.board !== undefined).map((p) => p.id);
  const [chosen, setChosen] = useState<string | null>(null);
  const board = chosen !== null && boards.includes(chosen) ? chosen : (boards[0] ?? null);
  const [timestamps, setTimestamps] = useState(false);
  const [ending, setEnding] = useState<Ending>('lf');
  const [text, setText] = useState('');
  const output = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = output.current;
    if (el === null) return;
    el.textContent = '';
    if (board === null) return;
    const buffer = serialBuffer(board);
    let renderedFrom = buffer.dropped; // buffer index of el.firstChild
    const lineText = (i: number): string => {
      const line = buffer.lines[i];
      return timestamps ? `[${(line.t / 1e9).toFixed(3)}] ${line.text}` : line.text;
    };
    const sync = (): void => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      // Lines that fell off the buffer's front (or a clear) leave the DOM too.
      let drop = buffer.dropped - renderedFrom;
      while (drop-- > 0 && el.firstChild !== null) el.firstChild.remove();
      renderedFrom = buffer.dropped;
      const shown = el.childElementCount;
      if (shown > 0) (el.lastElementChild as HTMLElement).textContent = lineText(shown - 1); // a partial line may have grown
      for (let i = shown; i < buffer.lines.length; i++) {
        const div = document.createElement('div');
        div.textContent = lineText(i);
        el.append(div);
      }
      if (atBottom) el.scrollTop = el.scrollHeight;
    };
    const dispose = effect(() => {
      void serialVersion.value;
      sync();
    });
    return dispose;
  }, [board, timestamps]);

  const send = (event: Event): void => {
    event.preventDefault();
    if (board === null) return;
    sim.serialSend(board, new TextEncoder().encode(text + ENDINGS[ending]));
    setText('');
  };

  return (
    <div class="serial-monitor">
      <div class="serial-bar">
        {boards.length > 1 &&
          boards.map((id) => (
            <button key={id} type="button" class={`chip${id === board ? ' active' : ''}`} onClick={() => setChosen(id)}>
              {id}
            </button>
          ))}
        <span class="serial-spacer" />
        <label class="chip-check">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps((e.target as HTMLInputElement).checked)} />
          Timestamps
        </label>
        <button
          type="button"
          class="chip"
          disabled={board === null}
          onClick={() => {
            if (board === null) return;
            serialBuffer(board).clear();
            serialVersion.value++;
          }}
        >
          Clear
        </button>
      </div>
      <div class="serial-output" ref={output} aria-live="polite">
        {board === null && <span class="muted">Add a board to see its serial output.</span>}
      </div>
      <form class="serial-input" onSubmit={send}>
        <input
          type="text"
          placeholder={board === null ? 'No board' : `Send to ${board}`}
          value={text}
          disabled={board === null}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        <select aria-label="Line ending" value={ending} onChange={(e) => setEnding((e.target as HTMLSelectElement).value as Ending)}>
          <option value="none">No line ending</option>
          <option value="lf">LF</option>
          <option value="crlf">CR LF</option>
        </select>
        <button type="submit" class="chip" disabled={board === null}>
          Send
        </button>
      </form>
    </div>
  );
}
