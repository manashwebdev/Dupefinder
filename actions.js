import { unlink, stat } from 'node:fs/promises';
import { formatBytes } from './report.js';

/**
 * Executes (or simulates) a deletion plan produced by planDeletions().
 *
 * SAFETY DESIGN:
 * - `dryRun` defaults to true at the call site (see bin/dupefinder.js) —
 *   the caller has to explicitly opt into real deletion with --apply.
 * - Every file is re-stat'd immediately before deletion. If its size
 *   changed since the scan, it's skipped rather than deleted — this
 *   guards against a file being modified between scan and delete
 *   (a classic TOCTOU race).
 * - Nothing is ever deleted without first appearing in the printed
 *   plan, dry-run or not — so a real run's output looks identical to
 *   the dry-run preview, just with an extra "deleted" line.
 *
 * @param {Array<{hash:string,size:number,keep:string,remove:string[]}>} plan
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @param {(msg: string) => void} [opts.onLog]
 * @returns {Promise<{ deleted: string[], skipped: string[], freedBytes: number }>}
 */
export async function executePlan(plan, { dryRun = true, onLog = console.log }) {
  const deleted = [];
  const skipped = [];
  let freedBytes = 0;

  for (const item of plan) {
    onLog(`\nKeeping:  ${item.keep}`);

    for (const target of item.remove) {
      if (dryRun) {
        onLog(`  [dry-run] would delete: ${target} (${formatBytes(item.size)})`);
        freedBytes += item.size;
        deleted.push(target); // "would delete", tracked under the same list for reporting
        continue;
      }

      try {
        const current = await stat(target);
        if (current.size !== item.size) {
          onLog(`  SKIPPED (changed since scan): ${target}`);
          skipped.push(target);
          continue;
        }
        await unlink(target);
        onLog(`  deleted: ${target} (${formatBytes(item.size)})`);
        deleted.push(target);
        freedBytes += item.size;
      } catch (err) {
        onLog(`  ERROR deleting ${target}: ${err.message}`);
        skipped.push(target);
      }
    }
  }

  return { deleted, skipped, freedBytes };
}
