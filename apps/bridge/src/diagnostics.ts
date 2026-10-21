/** Compiler messages from arduino-cli's `--json` output, in the shape the UI shows. */

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

interface CliDiagnostic {
  severity?: string;
  message?: string;
  file?: string;
  line?: number;
  column?: number;
}

/**
 * Reads `builder_result.diagnostics` (arduino-cli ≥ 0.36). Only the message's first line is
 * kept: the rest repeats the source line and a caret.
 */
export function parseDiagnostics(json: unknown): Diagnostic[] {
  const list = (json as { builder_result?: { diagnostics?: unknown } } | null)?.builder_result?.diagnostics;
  if (!Array.isArray(list)) return [];
  return list.map((item: unknown) => {
    const raw = (typeof item === 'object' && item !== null ? item : {}) as CliDiagnostic;
    const severity = String(raw.severity ?? '').toLowerCase();
    return {
      file: String(raw.file ?? ''),
      line: Number.isInteger(raw.line) ? (raw.line as number) : 0,
      column: Number.isInteger(raw.column) ? (raw.column as number) : 0,
      severity: severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info',
      message: String(raw.message ?? '').split('\n')[0],
    };
  });
}
