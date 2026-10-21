/** The `?` sheet (BT40): every shortcut and gesture from editor/shortcuts.ts, by group. */

import { useEffect, useRef } from 'preact/hooks';
import { PCB_SHORTCUTS, SHORTCUTS, shortcutsOpen } from '../editor/shortcuts.ts';

const GROUPS = ['Editing', 'Wiring', 'View', 'PCB', 'Help'] as const;
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function ShortcutsSheet() {
  const dialog = useRef<HTMLDialogElement>(null);
  const open = shortcutsOpen.value;
  useEffect(() => {
    const el = dialog.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={dialog} class="sheet" aria-label="Keyboard shortcuts" onClose={() => (shortcutsOpen.value = false)}>
      <header class="gallery-header">
        <h2>Keyboard shortcuts</h2>
        <span class="toolbar-spacer" />
        <button type="button" class="tool-button" onClick={() => (shortcutsOpen.value = false)}>
          Close
        </button>
      </header>
      <div class="sheet-body">
        {GROUPS.map((group) => (
          <section key={group} class="sheet-group">
            <h3>{group}</h3>
            <dl>
              {[...SHORTCUTS, ...PCB_SHORTCUTS].filter((s) => s.group === group).map((s) => (
                <div key={`${s.keys.other} ${s.label}`} class="sheet-row">
                  <dt>
                    <kbd>{MAC ? s.keys.mac : s.keys.other}</kbd>
                  </dt>
                  <dd>{s.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}
