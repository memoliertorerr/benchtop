/** A labelled box for part types without a view yet (or unknown types). */

import type { ViewFactory } from './registry.ts';

export const fallbackView: ViewFactory = {
  async create(def) {
    const el = document.createElement('div');
    el.className = 'part-fallback';
    el.style.width = `${def.size.w}mm`;
    el.style.height = `${def.size.h}mm`;
    el.textContent = def.title;
    return el;
  },
  setProps() {},
  update() {},
};
