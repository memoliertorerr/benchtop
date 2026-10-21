/**
 * The code editor (BT42): a textarea over a highlighted copy of its text, no editor library.
 * Both sit in one scroll container (the textarea is stretched over the <pre>, which sizes
 * them), so they can't drift apart; the line numbers are a sticky column beside them. The
 * textarea's own text is transparent — the colors come from tokenize.ts's spans underneath.
 *
 * Keys: Tab / Shift-Tab indent and unindent, Enter keeps the indentation (one level more after
 * `{`), ⌘/Ctrl-F find (Enter next, Shift-Enter previous, Esc closes), ⌘/Ctrl-S save, ⌘/Ctrl-Enter
 * Compile & Run. Edits go through insertText so the browser's undo history keeps them.
 * Compile errors and warnings tint their lines and mark the gutter.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Edit, find, INDENT, indent, lineOf, newline, PY_INDENT } from './edit-ops.ts';
import { type CodeLanguage, highlight } from './tokenize.ts';

/** px per line and the text's top padding — kept in step with the CSS (.code-scroll). */
const LINE = 18;
const PAD = 8;

export interface LineMark {
  line: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface CodeEditorProps {
  text: string;
  onText(text: string): void;
  onSave(): void;
  onCompile(): void;
  marks: readonly LineMark[];
  /** Scroll to and put the caret on this line when `reveal.nonce` changes. */
  reveal?: { line: number; nonce: number } | undefined;
  /** Names the textarea for assistive tech (the file name). */
  label: string;
  /** BT63: how the text is colored and indented (default Arduino C++). */
  language?: CodeLanguage;
}

export function CodeEditor({ text, onText, onSave, onCompile, marks, reveal, label, language = 'cpp' }: CodeEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const [notFound, setNotFound] = useState(false);

  // The highlighted copy is written as HTML directly: no virtual DOM for thousands of spans.
  useLayoutEffect(() => {
    if (pre.current !== null) pre.current.innerHTML = highlight(text, language);
    const el = area.current;
    if (el !== null && el.value !== text) el.value = text; // a file switch, an undo of the document
  }, [text, language]);

  const lines = useMemo(() => text.split('\n').length, [text]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n'), [lines]);

  const goToLine = (line: number, select = false): void => {
    const el = area.current;
    const box = scroller.current;
    if (el === null || box === null) return;
    const value = el.value;
    let start = 0;
    for (let l = 1; l < line && start >= 0; l++) start = value.indexOf('\n', start) + 1;
    const end = select ? (value.indexOf('\n', start) < 0 ? value.length : value.indexOf('\n', start)) : start;
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    const top = PAD + (line - 1) * LINE;
    if (top < box.scrollTop || top + LINE > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  };

  useLayoutEffect(() => {
    if (reveal !== undefined) goToLine(reveal.line, true);
  }, [reveal?.nonce]);

  const apply = (edit: Edit): void => {
    const el = area.current;
    if (el === null) return;
    el.focus();
    el.setSelectionRange(edit.from, edit.to);
    // insertText keeps the browser's undo stack; setRangeText is the fallback.
    const done = edit.insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, edit.insert);
    if (!done) {
      el.setRangeText(edit.insert, edit.from, edit.to, 'end');
      onText(el.value);
    }
    el.setSelectionRange(edit.selStart, edit.selEnd);
  };

  const findNext = (backwards: boolean): void => {
    const el = area.current;
    if (el === null) return;
    const at = find(el.value, query, backwards ? el.selectionStart : el.selectionEnd, backwards);
    setNotFound(at < 0 && query !== '');
    if (at < 0) return;
    const line = lineOf(el.value, at);
    goToLine(line);
    el.setSelectionRange(at, at + query.length);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const el = area.current;
    if (el === null) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Tab' && !mod && !event.altKey) {
      event.preventDefault();
      apply(indent(el.value, el.selectionStart, el.selectionEnd, event.shiftKey, language === 'python' ? PY_INDENT : INDENT));
    } else if (event.key === 'Enter' && mod) {
      event.preventDefault();
      onCompile();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      apply(newline(el.value, el.selectionStart, el.selectionEnd, language === 'python'));
    } else if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
    } else if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      const picked = el.value.slice(el.selectionStart, el.selectionEnd);
      if (picked !== '' && !picked.includes('\n')) setQuery(picked);
      setFinding(true);
      requestAnimationFrame(() => findInput.current?.select());
    } else if (event.key === 'Escape' && finding) {
      setFinding(false);
    }
  };

  return (
    <div class="code-editor">
      {finding && (
        <div class="code-find">
          <input
            ref={findInput}
            type="search"
            placeholder="Find"
            aria-label="Find"
            value={query}
            class={notFound ? 'not-found' : ''}
            onInput={(event) => {
              setQuery((event.target as HTMLInputElement).value);
              setNotFound(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                findNext(event.shiftKey);
              } else if (event.key === 'Escape') {
                setFinding(false);
                area.current?.focus();
              }
            }}
          />
          <button type="button" class="tool-button" title="Previous (Shift-Enter)" onClick={() => findNext(true)}>
            ↑
          </button>
          <button type="button" class="tool-button" title="Next (Enter)" onClick={() => findNext(false)}>
            ↓
          </button>
          <button type="button" class="tool-button" title="Close (Esc)" onClick={() => setFinding(false)}>
            ×
          </button>
        </div>
      )}
      <div class="code-scroll" ref={scroller}>
        <div class="code-gutter" aria-hidden="true">
          {numbers}
          {marks.map((m) => (
            <span key={`${m.line}:${m.message}`} class={`code-gutter-mark ${m.severity}`} style={{ top: `${PAD + (m.line - 1) * LINE}px` }} title={m.message} />
          ))}
        </div>
        <div class="code-body">
          {marks.map((m) => (
            <div key={`${m.line}:${m.message}`} class={`code-line-mark ${m.severity}`} style={{ top: `${PAD + (m.line - 1) * LINE}px` }} />
          ))}
          <pre class="code-highlight" ref={pre} aria-hidden="true" />
          <textarea
            ref={area}
            class="code-input"
            aria-label={label}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            wrap="off"
            onInput={(event) => onText((event.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
    </div>
  );
}
