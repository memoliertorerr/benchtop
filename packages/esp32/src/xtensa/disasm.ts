/**
 * objdump-exact disassembly: the mnemonic, a tab, then the operands joined by ", " — what
 * xtensa-esp32-elf-objdump -d prints, minus its ` <symbol+offset>` suffix. Formatting rules,
 * inferred from the BT27 corpora:
 *   - immediates with −256 < v < 256 print as signed decimal, others as 0x + unsigned 32-bit hex
 *     (`movi a2, 0x123`, `movi.n a1, -24`, `l16si a2, a1, 0x1b0`);
 *   - branch, jump, call, loop and l32r targets print as absolute lowercase hex without 0x;
 *   - special and user registers are part of the mnemonic (`rsr.prid`, `wur.threadptr`);
 *   - boolean groups print as `b4:b5:b6:b7`; MAC16 registers as m0–m3.
 * An invalid word has no text here (objdump prints `.byte 0x..` and moves on one byte); the
 * caller decides how to show it.
 */

import { D_IMM, D_IMM2, D_OP, D_R, D_S, D_T, target } from './decode.ts';
import { OP_INVALID, OPND, OPS } from './isa.ts';

/** objdump's immediate formatting. */
export function formatImmediate(v: number): string {
  return v > -256 && v < 256 ? String(v) : `0x${(v >>> 0).toString(16)}`;
}

function group(base: number, count: number): string {
  const regs: string[] = [];
  for (let i = 0; i < count; i++) regs.push(`b${base + i}`);
  return regs.join(':');
}

/** The operand text of a decoded instruction at `pc` ("" for none). */
export function operandText(desc: Int32Array, pc: number): string {
  const op = desc[D_OP];
  if (op === OP_INVALID) return '';
  const r = desc[D_R];
  const s = desc[D_S];
  const t = desc[D_T];
  const parts: string[] = [];
  for (const kind of OPS[op].operands) {
    switch (kind) {
      case OPND.AR:
        parts.push(`a${r}`);
        break;
      case OPND.AS:
        parts.push(`a${s}`);
        break;
      case OPND.AT:
        parts.push(`a${t}`);
        break;
      case OPND.FR:
        parts.push(`f${r}`);
        break;
      case OPND.FS:
        parts.push(`f${s}`);
        break;
      case OPND.FT:
        parts.push(`f${t}`);
        break;
      case OPND.BR:
        parts.push(`b${r}`);
        break;
      case OPND.BS:
        parts.push(`b${s}`);
        break;
      case OPND.BT:
        parts.push(`b${t}`);
        break;
      case OPND.B4:
        parts.push(group(s & ~3, 4));
        break;
      case OPND.B8:
        parts.push(group(s & ~7, 8));
        break;
      case OPND.MW:
        parts.push(`m${r & 3}`);
        break;
      case OPND.MX:
        parts.push(`m${(r >> 2) & 1}`);
        break;
      case OPND.MY:
        parts.push(`m${2 + ((t >> 2) & 1)}`);
        break;
      case OPND.IMM:
        parts.push(formatImmediate(desc[D_IMM]));
        break;
      case OPND.IMM2:
        parts.push(formatImmediate(desc[D_IMM2]));
        break;
      case OPND.TGT:
        parts.push(target(desc, pc).toString(16));
        break;
    }
  }
  return parts.join(', ');
}

/** `mnemonic\toperands` (no tab when there are no operands), or undefined for an invalid word. */
export function disasm(desc: Int32Array, pc: number): string | undefined {
  const op = desc[D_OP];
  if (op === OP_INVALID) return undefined;
  const operands = operandText(desc, pc);
  return operands === '' ? OPS[op].name : `${OPS[op].name}\t${operands}`;
}
