/**
 * Formats byte counts as human-readable sizes (KB/MB/GB).
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exp);
  return `${value.toFixed(exp === 0 ? 0 : 2)} ${units[exp]}`;
}

/**
 * Prints a human-readable duplicate report to stdout.
 * @param {Array<{hash:string,size:number,files:string[]}>} duplicateGroups
 * @param {{scanned:number,sizeCandidates:number,hashed:number,errors:number}} stats
 */
export function printReport(duplicateGroups, stats) {
  console.log('\n=== Duplicate Scan Report ===');
  console.log(`Files scanned:        ${stats.scanned}`);
  console.log(`Hash candidates:      ${stats.sizeCandidates}  (files sharing a size with another file)`);
  console.log(`Files hashed:         ${stats.hashed}`);
  console.log(`Errors/skips:         ${stats.errors}`);
  console.log(`Duplicate groups:     ${duplicateGroups.length}`);

  if (duplicateGroups.length === 0) {
    console.log('\nNo duplicates found.\n');
    return;
  }

  let wastedBytes = 0;
  console.log('');

  duplicateGroups.forEach((group, i) => {
    const wasted = group.size * (group.files.length - 1);
    wastedBytes += wasted;
    console.log(`[${i + 1}] hash=${group.hash.slice(0, 12)}...  size=${formatBytes(group.size)}  copies=${group.files.length}  wasted=${formatBytes(wasted)}`);
    for (const f of group.files) {
      console.log(`      ${f}`);
    }
  });

  console.log(`\nTotal reclaimable space: ${formatBytes(wastedBytes)}\n`);
}

/**
 * Builds a plain-object report suitable for JSON.stringify — used by
 * --json output mode so results can be piped into other tools.
 */
export function toJsonReport(duplicateGroups, stats) {
  const wastedBytes = duplicateGroups.reduce(
    (sum, g) => sum + g.size * (g.files.length - 1),
    0,
  );
  return {
    stats,
    duplicateGroupCount: duplicateGroups.length,
    reclaimableBytes: wastedBytes,
    groups: duplicateGroups,
  };
}
