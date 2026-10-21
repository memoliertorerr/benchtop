/**
 * The AudioWorkletGlobalScope members our processors use (BT41). The DOM lib types the main
 * thread's side (AudioWorkletNode) but not the worklet's own globals.
 */

export interface WorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

interface WorkletScope {
  /** The AudioContext's sample rate. */
  readonly sampleRate: number;
  readonly AudioWorkletProcessor: new () => { readonly port: MessagePort };
  registerProcessor(name: string, processor: new (options: { processorOptions?: unknown }) => WorkletProcessor): void;
}

/** The worklet global scope (only meaningful inside an AudioWorklet). */
export const scope = globalThis as unknown as WorkletScope;
