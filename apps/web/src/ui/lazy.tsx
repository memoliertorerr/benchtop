/**
 * A component loaded on first render (BT59: the PCB view, its Inspector and DRC rows live in a
 * chunk of their own, so the bench loads without @benchtop/pcb). Renders `fallback` until the
 * module arrives.
 */

import type { ComponentType, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, fallback: () => JSX.Element | null = () => null): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  return function Lazy(props: P) {
    const [component, setComponent] = useState<ComponentType<P> | null>(loaded);
    useEffect(() => {
      if (loaded !== null) return;
      pending ??= load();
      let alive = true;
      void pending.then((c) => {
        loaded = c;
        if (alive) setComponent(() => c);
      });
      return () => {
        alive = false;
      };
    }, []);
    const Component = component;
    return Component === null ? fallback() : <Component {...props} />;
  };
}
