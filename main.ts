// A tiny stack VM for make.fun's tiny stack ISA v1: 32-bit wrapping
// integers, a 256-value stack, 64 return addresses, 256 words of memory,
// a 1,000,000 step limit and a 65,536 byte output limit. Trap exit codes:
// 2 underflow, 3 overflow, 4 div by zero, 5 bad opcode, 6 bad address,
// 7 call overflow, 8 RET with no caller, 9 pc outside program, 10 steps,
// 11 output limit.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function run(prog: Uint8Array, input: Uint8Array): { bytes: Uint8Array; code: number } {
  const st: number[] = [], ra: number[] = [], mem = new Int32Array(256);
  const out = new Uint8Array(65536);
  let pc = 0, steps = 0, inp = 0, len = 0;
  const need = (n: number): void => { if (st.length < n) throw 2; };
  const push = (v: number): void => { if (st.length >= 256) throw 3; st.push(v | 0); };
  // immediate at pc+1
  const imm = (n: number, sgn: boolean): number => {
    if (pc + n >= prog.length) throw 9;
    let v = 0;
    for (let i = n; i >= 1; i--) v = (v << 8) | prog[pc + i];
    return sgn && n < 4 ? (v << (32 - 8 * n)) >> (32 - 8 * n) : v;
  };
  try {
    for (;;) {
      if (steps >= 1000000) throw 10;
      if (pc < 0 || pc >= prog.length) throw 9;
      const op = prog[pc];
      steps++;
      switch (op) {
        case 0x00: return { bytes: out.subarray(0, len), code: 0 }; // HALT
        case 0x01: push(imm(1, true)); pc += 2; break; // PUSH8
        case 0x02: push(imm(4, false)); pc += 5; break; // PUSH32
        case 0x03: need(1); st.pop(); pc++; break; // POP
        case 0x04: need(1); push(st[st.length - 1]); pc++; break; // DUP
        case 0x05: { // SWAP
          need(2);
          const t = st[st.length - 1];
          st[st.length - 1] = st[st.length - 2];
          st[st.length - 2] = t;
          pc++;
          break;
        }
        case 0x06: need(2); push(st[st.length - 2]); pc++; break; // OVER
        case 0x07: { // ROT ( a b c -- b c a )
          need(3);
          const a = st[st.length - 3];
          st[st.length - 3] = st[st.length - 2];
          st[st.length - 2] = st[st.length - 1];
          st[st.length - 1] = a;
          pc++;
          break;
        }
        case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
        case 0x16: case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d:
        case 0x1e: case 0x20: case 0x21: case 0x22: { // binary: pop b, then a
          need(2);
          const b = st.pop()!, a = st.pop()!;
          let r: number;
          if (op === 0x10) r = (a + b) | 0; // ADD
          else if (op === 0x11) r = (a - b) | 0; // SUB
          else if (op === 0x12) r = Math.imul(a, b); // MUL, low 32 bits
          else if (op === 0x13) { if (b === 0) throw 4; r = Math.trunc(a / b) | 0; } // DIV
          else if (op === 0x14) { if (b === 0) throw 4; r = (a % b) | 0; } // MOD
          else if (op === 0x15) { if (b === 0) throw 4; r = Math.trunc((a >>> 0) / (b >>> 0)) | 0; } // DIVU
          else if (op === 0x16) { if (b === 0) throw 4; r = ((a >>> 0) % (b >>> 0)) | 0; } // MODU
          else if (op === 0x18) r = a & b; // AND
          else if (op === 0x19) r = a | b; // OR
          else if (op === 0x1a) r = a ^ b; // XOR
          else if (op === 0x1c) r = a << (b & 31); // SHL
          else if (op === 0x1d) r = a >> (b & 31); // SHR, arithmetic
          else if (op === 0x1e) r = (a >>> (b & 31)) | 0; // SHRU, logical
          else if (op === 0x20) r = a === b ? 1 : 0; // EQ
          else if (op === 0x21) r = a < b ? 1 : 0; // LT
          else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
          st.push(r);
          pc++;
          break;
        }
        case 0x17: need(1); st[st.length - 1] = (-st[st.length - 1]) | 0; pc++; break; // NEG
        case 0x1b: need(1); st[st.length - 1] = ~st[st.length - 1]; pc++; break; // NOT
        case 0x30: pc = pc + 3 + imm(2, true); break; // JMP
        case 0x31: { const o = imm(2, true); need(1); pc = st.pop()! === 0 ? pc + 3 + o : pc + 3; break; } // JZ
        case 0x32: { const o = imm(2, true); need(1); pc = st.pop()! !== 0 ? pc + 3 + o : pc + 3; break; } // JNZ
        case 0x33: { // CALL
          const t = imm(2, false);
          if (ra.length >= 64) throw 7;
          ra.push(pc + 3);
          pc = t;
          break;
        }
        case 0x34: if (ra.length === 0) throw 8; pc = ra.pop()!; break; // RET
        case 0x40: { // LOAD
          need(1);
          const a = st.pop()!;
          if (a < 0 || a > 255) throw 6;
          st.push(mem[a]);
          pc++;
          break;
        }
        case 0x41: { // STORE ( v addr -- )
          need(2);
          const a = st.pop()!, v = st.pop()!;
          if (a < 0 || a > 255) throw 6;
          mem[a] = v;
          pc++;
          break;
        }
        case 0x50: { // PRINT, decimal ASCII
          need(1);
          const s = String(st.pop()!);
          if (len + s.length > 65536) throw 11;
          for (let i = 0; i < s.length; i++) out[len++] = s.charCodeAt(i);
          pc++;
          break;
        }
        case 0x51: need(1); if (len >= 65536) throw 11; out[len++] = st.pop()! & 255; pc++; break; // PUTC
        case 0x52: push(inp < input.length ? input[inp++] : -1); pc++; break; // IN
        case 0x53: need(1); return { bytes: out.subarray(0, len), code: st.pop()! & 255 }; // EXIT
        default: throw 5; // unknown opcode
      }
    }
  } catch (e) {
    if (typeof e === 'number') return { bytes: out.subarray(0, len), code: e };
    throw e;
  }
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(inputDir).sort()) {
  const prog = new Uint8Array(readFileSync(join(inputDir, id, 'program.bin')));
  let input = new Uint8Array(0);
  try {
    input = new Uint8Array(readFileSync(join(inputDir, id, 'input.bin')));
  } catch {}
  const { bytes, code } = run(prog, input);
  mkdirSync(join(outputDir, id), { recursive: true });
  writeFileSync(join(outputDir, id, 'stdout.bin'), bytes);
  writeFileSync(join(outputDir, id, 'exit.txt'), String(code) + '\n');
}
