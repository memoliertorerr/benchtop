/**
 * Step over, for any McuDebug. A call executes and then runs until it returns: a temporary
 * breakpoint at the instruction after the call, hit with SP back at or above its value before
 * the call (so a recursive call reaching the same address deeper in the stack doesn't count).
 * Anything else is one step. The pieces are exported so a non-blocking runner (the worker's
 * paced loop) can drive the same logic a frame at a time.
 */

import type { McuDebug } from '../contracts/debug.ts';
import type { RunResult } from '../contracts/mcu.ts';

export interface StepOverPlan {
  /** The return address: the call's address + its size. */
  readonly target: number;
  /** SP before the call. */
  readonly sp: number;
  /** Whether the breakpoint at `target` is ours (removed when done). */
  readonly temporary: boolean;
}

export type StepResult =
  /** Landed on the next instruction (one step, or the call returned). */
  | { reason: 'stepped' }
  /** Stopped at a user breakpoint first. */
  | { reason: 'breakpoint' }
  /** The runner gave up (time budget), still inside the call. */
  | { reason: 'limit' }
  | { reason: 'halted' | 'fault'; detail?: string | undefined };

const scratch = new Uint32Array(64);

/** PC and SP now. */
export function pcAndSp(debug: McuDebug): { pc: number; sp: number } {
  const regs = debug.registers().length <= scratch.length ? scratch : new Uint32Array(debug.registers().length);
  debug.readRegisters(regs);
  return { pc: regs[debug.pcIndex], sp: regs[debug.spIndex] };
}

/**
 * Starts a step over. Not at a call: steps once and returns null. At a call: executes the call
 * instruction, arms the return breakpoint and returns the plan to finish with `stepOverLanded`.
 */
export function beginStepOver(debug: McuDebug): StepOverPlan | null {
  const { pc, sp } = pcAndSp(debug);
  const instruction = debug.instructionAt(pc);
  if (!instruction.isCall) {
    debug.step();
    return null;
  }
  const target = pc + instruction.size;
  const temporary = !debug.breakpoints().includes(target);
  if (temporary) debug.setBreakpoint(target);
  debug.step(); // the call itself
  return { target, sp, temporary };
}

/**
 * After a breakpoint stop during a step over: 'stepped' when the call returned, 'breakpoint'
 * when another (user) breakpoint stopped it, 'continue' when the return address was hit deeper
 * in a recursion. Disarms the temporary breakpoint unless it's 'continue'.
 */
export function stepOverStopped(debug: McuDebug, plan: StepOverPlan): 'stepped' | 'breakpoint' | 'continue' {
  const { pc, sp } = pcAndSp(debug);
  let outcome: 'stepped' | 'breakpoint' | 'continue';
  if (pc === plan.target && sp >= plan.sp) outcome = 'stepped';
  else if (pc === plan.target && plan.temporary) outcome = 'continue';
  else outcome = 'breakpoint';
  if (outcome !== 'continue') endStepOver(debug, plan);
  return outcome;
}

/** Disarms the temporary breakpoint (also when a step over is abandoned). */
export function endStepOver(debug: McuDebug, plan: StepOverPlan): void {
  if (plan.temporary) debug.clearBreakpoint(plan.target);
}

/**
 * A blocking step over. `run` runs the MCU (and whatever it lives in) until a breakpoint or its
 * own budget; it is called again after a deeper hit of the return address, at most `maxRuns`
 * times.
 */
export function stepOver(debug: McuDebug, run: () => RunResult, maxRuns = 1000): StepResult {
  const plan = beginStepOver(debug);
  if (plan === null) return { reason: 'stepped' };
  for (let k = 0; k < maxRuns; k++) {
    const result = run();
    if (result.reason === 'target') continue;
    if (result.reason !== 'breakpoint') {
      endStepOver(debug, plan);
      return { reason: result.reason, detail: result.detail };
    }
    const outcome = stepOverStopped(debug, plan);
    if (outcome !== 'continue') return { reason: outcome };
  }
  endStepOver(debug, plan);
  return { reason: 'limit' };
}
