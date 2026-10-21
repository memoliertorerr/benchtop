/**
 * The examples gallery (BT38): a dialog of cards — a live preview of the example's circuit (its
 * parts drawn by their own views, scaled to fit, wires as plain paths; nothing runs), the title,
 * a one-line description and the board — grouped by category, with a filter box. Projects load
 * when the gallery opens; a card opens its example.
 */

import { parseProject, type PartInstance, type ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { PX_PER_MM } from '../editor/camera.ts';
import { docBounds } from '../editor/frame.ts';
import { pinPosition } from '../editor/pins.ts';
import { orthogonalPath, pathData } from '../editor/routing.ts';
import { openExample } from '../examples/index.ts';
import { boardBadge, CATEGORIES, EXAMPLES, type Example, loadProject } from '../examples/manifest.ts';
import { viewFor } from '../views/registry.ts';

export const galleryOpen = signal(false);

const CARD_W = 248;
const CARD_H = 150;
const MARGIN = 10;

function PreviewPart({ part }: { part: PartInstance }) {
  const wrapper = useRef<HTMLDivElement>(null);
  const def = CATALOG.get(part.type);
  useEffect(() => {
    if (def === undefined) return;
    let alive = true;
    let element: HTMLElement | null = null;
    viewFor(part.type)
      .create(def, { ...def.defaults, ...part.props })
      .then((el) => {
        if (!alive) return;
        el.classList.add('part-element');
        element = el;
        wrapper.current?.append(el);
      })
      .catch(() => {});
    return () => {
      alive = false;
      element?.remove();
    };
  }, [part]);
  const size = def?.size ?? { w: 10, h: 10 };
  return (
    <div
      ref={wrapper}
      class="preview-part"
      style={{
        left: `${part.x * PX_PER_MM}px`,
        top: `${part.y * PX_PER_MM}px`,
        width: `${size.w * PX_PER_MM}px`,
        height: `${size.h * PX_PER_MM}px`,
        transform: part.rotation === 0 ? '' : `rotate(${part.rotation}deg)`,
      }}
    />
  );
}

/** A non-interactive drawing of a document, scaled to fit `width` × `height` px. */
export function ProjectPreview({ doc, width = CARD_W, height = CARD_H }: { doc: ProjectDoc; width?: number; height?: number }) {
  const rect = docBounds(doc) ?? { x: 0, y: 0, w: 1, h: 1 };
  const s = Math.min((width - 2 * MARGIN) / (rect.w * PX_PER_MM), (height - 2 * MARGIN) / (rect.h * PX_PER_MM), 1);
  const tx = width / 2 - (rect.x + rect.w / 2) * PX_PER_MM * s;
  const ty = height / 2 - (rect.y + rect.h / 2) * PX_PER_MM * s;
  const wires = doc.wires.flatMap((w) => {
    const from = pinPosition(doc, w.from);
    const to = pinPosition(doc, w.to);
    if (from === undefined || to === undefined) return [];
    const px = orthogonalPath([from, ...w.waypoints, to]).map((p) => ({ x: p.x * PX_PER_MM, y: p.y * PX_PER_MM }));
    return [{ id: w.id, color: w.color, d: pathData(px, PX_PER_MM) }];
  });
  return (
    <div class="preview" style={{ width: `${width}px`, height: `${height}px` }} aria-hidden="true">
      <div class="preview-world" style={{ transform: `translate(${tx}px, ${ty}px) scale(${s})` }}>
        {doc.parts.map((part) => (
          <PreviewPart key={part.id} part={part} />
        ))}
        <svg class="preview-wires" width="1" height="1">
          {wires.map((w) => (
            <path key={w.id} d={w.d} stroke={w.color} />
          ))}
        </svg>
      </div>
    </div>
  );
}

function Card({ example, doc }: { example: Example; doc: ProjectDoc | undefined }) {
  return (
    <button
      type="button"
      class="example-card"
      onClick={() => {
        galleryOpen.value = false;
        void openExample(example.id);
      }}
    >
      {doc === undefined ? <div class="preview" style={{ width: `${CARD_W}px`, height: `${CARD_H}px` }} /> : <ProjectPreview doc={doc} />}
      <span class="example-title">
        {example.title}
        {Object.entries(example.boards).map(([id, b]) => {
          const badge = boardBadge(b);
          return (
            <span key={id} class={`example-board ${badge.kind}`}>
              {badge.label}
            </span>
          );
        })}
      </span>
      <span class="example-description">{example.description}</span>
    </button>
  );
}

export function ExamplesGallery() {
  const [docs, setDocs] = useState<Record<string, ProjectDoc>>({});
  const [filter, setFilter] = useState('');
  const open = galleryOpen.value;
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    if (!open || Object.keys(docs).length > 0) return;
    let alive = true;
    void Promise.all(
      EXAMPLES.map(async (e) => {
        try {
          const json = await loadProject(e);
          const parsed = parseProject((json as { default?: unknown }).default ?? json);
          return parsed.ok ? ([e.id, parsed.doc] as const) : undefined;
        } catch {
          return undefined;
        }
      }),
    ).then((entries) => {
      if (alive) setDocs(Object.fromEntries(entries.filter((x) => x !== undefined)));
    });
    return () => {
      alive = false;
    };
  }, [open]);

  const needle = filter.trim().toLowerCase();
  const shown = EXAMPLES.filter((e) => needle === '' || `${e.title} ${e.description} ${e.category}`.toLowerCase().includes(needle));
  return (
    <dialog ref={dialog} class="gallery" aria-label="Examples" onClose={() => (galleryOpen.value = false)}>
      <header class="gallery-header">
        <h2>Examples</h2>
        <input class="gallery-filter" type="search" placeholder="Filter examples" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <button type="button" class="tool-button" onClick={() => (galleryOpen.value = false)}>
          Close
        </button>
      </header>
      {open && (
        <div class="gallery-body">
          {CATEGORIES.map((category) => {
            const list = shown.filter((e) => e.category === category);
            if (list.length === 0) return null;
            return (
              <section key={category} class="gallery-section">
                <h3>{category}</h3>
                <div class="gallery-grid">
                  {list.map((e) => (
                    <Card key={e.id} example={e} doc={docs[e.id]} />
                  ))}
                </div>
              </section>
            );
          })}
          {shown.length === 0 && <p class="muted panel-note">No example matches "{filter}".</p>}
        </div>
      )}
    </dialog>
  );
}
