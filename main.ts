// The entrypoint make.fun runs: node /bot/main.ts, one process for the whole set.
// For every instance under MAKEFUN_INPUT_DIR (default /input) it reads level.txt, asks solve.js for the
// player's moves and writes them to MAKEFUN_OUTPUT_DIR/<id>/solution.txt (default /output).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './solve.js';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// One push-expansion budget for the whole set. It is a count of states, never the clock, so the work a run
// does is the same every time and two executions write the same bytes.
const budget = { left: 2_000_000 };

const ids = readdirSync(INPUT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const id of ids) {
  let moves = '';
  try {
    const level = readFileSync(join(INPUT, id, 'level.txt'), 'utf8');
    const answer = run(level, budget);
    if (answer !== null) moves = answer.moves;
  } catch {
    // A level the reader cannot parse still gets an answer in the accepted format: no moves.
    moves = '';
  }
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), moves + '\n');
}
