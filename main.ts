// main.ts — read a snapshot, score it, and lay out an output directory for the
// token-radar dashboard. Node 22, standard library only, erasable TypeScript.
//
//   node main.ts --input ./input --output ./out

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { buildDossier, DossierError } from './vendor/makefun-board.ts';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';

const DEFAULT_INPUT = '/input';
const DEFAULT_OUTPUT = '/output';
const SCREENSHOT_NAME = /^[A-Za-z0-9._-]+$/;
const MAX_DOSSIER_SHOTS = 4;

interface Args {
  input: string;
  output: string;
}

/** Parse `--flag value` and `--flag=value`; unknown flags are ignored with a warning. */
function parseArgs(argv: string[]): Args {
  const out: Args = {
    input: process.env.MAKEFUN_INPUT_DIR || DEFAULT_INPUT,
    output: process.env.MAKEFUN_OUTPUT_DIR || DEFAULT_OUTPUT,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const take = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i++;
      return next;
    };
    if (name === 'input') {
      const v = take();
      if (v === null) die(2, '--input needs a file or directory path');
      out.input = v;
    } else if (name === 'output') {
      const v = take();
      if (v === null) die(2, '--output needs a directory path');
      out.output = v;
    }
  }
  return out;
}

function die(code: number, message: string): never {
  process.stderr.write(`token-radar: ${message}\n`);
  process.exit(code);
}

/** The snapshot path: the given file, or snapshot.json inside the given directory. */
function snapshotPath(input: string): string {
  const abs = resolve(input);
  if (!existsSync(abs)) die(2, `input not found: ${abs}`);
  if (statSync(abs).isDirectory()) {
    const inside = join(abs, 'snapshot.json');
    if (!existsSync(inside)) die(2, `no snapshot.json in input directory: ${abs}`);
    return inside;
  }
  return abs;
}

/** Copy a directory's regular files and subdirectories, skipping dotfiles; returns copied names. */
function copyTree(from: string, to: string, filter?: (name: string) => boolean): string[] {
  if (!existsSync(from) || !statSync(from).isDirectory()) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (filter && !filter(entry.name)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyTree(src, dst).map((n) => `${entry.name}/${n}`));
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
      copied.push(entry.name);
    }
  }
  return copied;
}

/** Validate screenshots and copy them, newest-name last; refuses bad names and too few shots. */
function copyScreenshots(from: string, to: string): string[] {
  const names: string[] = [];
  if (existsSync(from) && statSync(from).isDirectory()) {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      if (!SCREENSHOT_NAME.test(entry.name)) {
        die(1, `screenshot name "${entry.name}" is not letters, digits, dot, underscore or dash`);
      }
      names.push(entry.name);
    }
  }
  if (names.length < 3) die(1, `screenshots/ holds ${names.length} files; at least 3 are required`);
  names.sort();
  mkdirSync(to, { recursive: true });
  const keep = names.slice(0, MAX_DOSSIER_SHOTS);
  if (names.length > keep.length) {
    process.stderr.write(
      `token-radar: copying ${keep.length} of ${names.length} screenshots; the dossier holds at most ${MAX_DOSSIER_SHOTS}\n`,
    );
  }
  for (const name of keep) copyFileSync(join(from, name), join(to, name));
  return keep;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = snapshotPath(args.input);
  const outDir = resolve(args.output);

  const snapshot = (() => {
    try {
      return parseSnapshot(readFileSync(inputFile, 'utf8'));
    } catch (err) {
      die(2, `cannot read snapshot ${basename(inputFile)}: ${(err as Error).message}`);
    }
  })();

  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) die(1, issue);

  mkdirSync(outDir, { recursive: true });

  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board }, null, 2)}\n`);
  writeFileSync(join(outDir, 'data.js'), dataScript(radar));

  const dashFrom = join(process.cwd(), 'dashboard');
  if (existsSync(dashFrom)) copyTree(dashFrom, join(outDir, 'dashboard'));
  else process.stderr.write(`token-radar: no dashboard/ beside main.ts; skipping dashboard copy\n`);

  // Prefer the repo's screenshots/ next to main.ts; when the input already
  // carries some, copy them in and the count check still applies.
  const shotsFrom = existsSync(join(process.cwd(), 'screenshots'))
    ? join(process.cwd(), 'screenshots')
    : join(outDir, 'screenshots');
  if (existsSync(shotsFrom)) copyScreenshots(shotsFrom, join(outDir, 'screenshots'));

  process.stdout.write(
    `token-radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} rows scored\n`,
  );

  // The dossier is written last: it hashes everything already in the output dir.
  try {
    const dossier = buildDossier(outDir, {
      text_max_bytes: 65536,
      screenshots: { max: 4, max_bytes: 524288 },
      dashboard: { max_files: 400, max_bytes: 4194304 },
    });
    writeFileSync(join(outDir, 'dossier.json'), dossier);
  } catch (err) {
    if (err instanceof DossierError) die(1, `dossier: ${err.message}`);
    throw err;
  }
}

main();
