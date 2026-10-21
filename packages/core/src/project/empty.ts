import { PROJECT_FORMAT, type ProjectDoc } from '../contracts/project.ts';

/** A new document with nothing on the bench. Used by the editor's "New" and by tests. */
export function emptyProject(name: string): ProjectDoc {
  return { format: PROJECT_FORMAT, name, parts: [], wires: [], firmware: {} };
}
