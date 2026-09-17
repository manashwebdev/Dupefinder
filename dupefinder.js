#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { stat, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

import { findDuplicates, planDeletions } from '../lib/duplicates.js';
import { printReport, toJsonReport } from '../lib/report.js';
import { executePlan } from '../lib/actions.js';

const HELP = `
dupefinder — recursive duplicate file finder

USAGE:
  dupefinder <directory> [options]

OPTIONS:
  --algorithm <md5|sha1|sha256>   Hash algorithm (default: sha256)
  --keep <oldest|newest|first-path>  Which copy to keep per group (default: oldest)
  --apply                        Actually delete duplicates (default: dry-run)
  --yes                          Skip the confirmation prompt when --apply is used
  --json                         Print machine-readable JSON instead of a text report
  --concurrency <n>               Parallel hash operations (default: 8)
  --help                         Show this help

SAFETY:
  By default this tool NEVER deletes anything. Without --apply it only
  reports duplicates and shows exactly what a real run would delete.
  You must pass --apply to actually remove files, and you'll be asked
  to confirm unless --yes is also given.

EXAMPLES:
  dupefinder ./photos
  dupefinder ./photos --algorithm md5 --json
  dupefinder ./photos --apply --keep newest
`;

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      algorithm: { type: 'string', default: 'sha256' },
      keep: { type: 'string', default: 'oldest' },
      apply: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '8' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const targetDir = resolve(positionals[0]);
  const algorithm = values.algorithm.toLowerCase();
  const keepStrategy = values.keep.toLowerCase();
  const concurrency = Math.max(1, parseInt(values.concurrency, 10) || 8);
  const dryRun = !values.apply;

  if (!['md5', 'sha1', 'sha256'].includes(algorithm)) {
    console.error(`Unsupported algorithm: ${algorithm}. Use md5, sha1, or sha256.`);
    process.exit(1);
  }
  if (!['oldest', 'newest', 'first-path'].includes(keepStrategy)) {
    console.error(`Unsupported --keep strategy: ${keepStrategy}. Use oldest, newest, or first-path.`);
    process.exit(1);
  }

  try {
    const rootStat = await lstat(targetDir);
    if (!rootStat.isDirectory()) {
      console.error(`Not a directory: ${targetDir}`);
      process.exit(1);
    }
  } catch {
    console.error(`Path does not exist: ${targetDir}`);
    process.exit(1);
  }

  if (!values.json) {
    console.log(`Scanning: ${targetDir}`);
    console.log(`Algorithm: ${algorithm} | Concurrency: ${concurrency} | Mode: ${dryRun ? 'DRY RUN (safe)' : 'APPLY (will delete)'}`);
  }

  const onProgress = values.json ? () => {} : (msg) => console.log(msg);

  const { duplicateGroups, stats } = await findDuplicates(targetDir, {
    algorithm,
    concurrency,
    onProgress,
  });

  if (values.json) {
    // JSON mode: print the report and exit. Deletion via --apply is
    // intentionally not combined with --json, to keep piped output
    // stable and side-effect-free.
    console.log(JSON.stringify(toJsonReport(duplicateGroups, stats), null, 2));
    return;
  }

  printReport(duplicateGroups, stats);

  if (duplicateGroups.length === 0) return;

  // Build mtime lookup for the keep-strategy sort.
  const allPaths = duplicateGroups.flatMap((g) => g.files);
  const mtimeByPath = new Map();
  await Promise.all(allPaths.map(async (p) => {
    try {
      const s = await stat(p);
      mtimeByPath.set(p, s.mtimeMs);
    } catch {
      mtimeByPath.set(p, 0);
    }
  }));

  const plan = planDeletions(duplicateGroups, keepStrategy, mtimeByPath);
  const totalToRemove = plan.reduce((n, item) => n + item.remove.length, 0);

  console.log(`Deletion plan: keep 1 file per group (strategy: ${keepStrategy}), remove ${totalToRemove} duplicate file(s).`);

  if (dryRun) {
    await executePlan(plan, { dryRun: true, onLog: console.log });
    console.log('\nThis was a DRY RUN — no files were deleted. Re-run with --apply to actually delete.');
    return;
  }

  if (!values.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nAbout to permanently delete ${totalToRemove} file(s). Type "yes" to confirm: `);
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted. No files were deleted.');
      return;
    }
  }

  const result = await executePlan(plan, { dryRun: false, onLog: console.log });
  console.log(`\nDone. Deleted ${result.deleted.length} file(s), skipped ${result.skipped.length}.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
