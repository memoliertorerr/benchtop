import type { PartDefinition, PartProps } from '@benchtop/core';

/** Identity helper so a definition's props type is inferred from `defaults`. */
export function definePart<P extends PartProps>(definition: PartDefinition<P>): PartDefinition<P> {
  return definition;
}
