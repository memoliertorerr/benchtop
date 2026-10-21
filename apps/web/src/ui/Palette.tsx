import { CATALOG, PART_CATEGORIES } from '@benchtop/parts';
import { useState } from 'preact/hooks';
import { editor } from '../editor/app-store.ts';
import { canvasCenter, PART_MIME } from '../editor/Canvas.tsx';

/** The part catalog by category, with search. Drag a part onto the bench, or double-click it. */
export function Palette() {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const definitions = [...CATALOG.values()];
  const groups = PART_CATEGORIES.map((category) => ({
    ...category,
    parts: definitions.filter(
      (d) => d.category === category.id && (q === '' || d.title.toLowerCase().includes(q) || d.type.includes(q)),
    ),
  })).filter((group) => group.parts.length > 0);

  return (
    <aside class="palette" aria-label="Parts">
      <div class="panel-title">Parts</div>
      <input
        class="palette-search"
        type="search"
        placeholder="Search parts"
        value={query}
        onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
      />
      {groups.length === 0 && <p class="muted">No part matches “{query}”.</p>}
      {groups.map((group) => (
        <section key={group.id} class="palette-section">
          <div class="palette-group-title">{group.title}</div>
          <ul class="palette-list">
            {group.parts.map((def) => (
              <li
                key={def.type}
                class="palette-item"
                draggable
                title={`Drag onto the bench (or double-click) to add a ${def.title}`}
                onDragStart={(event) => {
                  event.dataTransfer?.setData(PART_MIME, def.type);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
                }}
                onDblClick={() => {
                  const center = canvasCenter();
                  editor.addPart(def.type, { x: center.x - def.size.w / 2, y: center.y - def.size.h / 2 });
                }}
              >
                {def.title}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
