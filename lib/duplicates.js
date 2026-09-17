import { walk } from './scanner.js';
import { hashFile, mapWithConcurrency } from './hasher.js';

/**
 * Finds duplicate files under rootDir.
 *
 * Two-phase strategy (the classic systems-level optimization for this
 * problem): files can only be duplicates if they're the same size, so
 * we group by size first — an O(n) pass with no hashing at all — and
 * only pay the cost of hashing (reading full file contents) for files
 * that actually share a size with at least one other file. On a real
 * filesystem this typically eliminates 90%+ of files from ever being
 * hashed.
 *
 * @param {string} rootDir
 * @param {object} [opts]
 * @param {string} [opts.algorithm='sha256'] - 'md5' | 'sha1' | 'sha256'
 * @param {number} [opts.concurrency=8] - parallel hash operations
 * @param {(msg: string) => void} [opts.onProgress]
 * @returns {Promise<{
 *   duplicateGroups: Array<{ hash: string, size: number, files: string[] }>,
 *   stats: { scanned: number, sizeCandidates: number, hashed: number, errors: number }
 * }>}
 */
export async function findDuplicates(rootDir, opts = {}) {
  const {
    algorithm = 'sha256',
    concurrency = 8,
    onProgress = () => {},
  } = opts;

  const stats = { scanned: 0, sizeCandidates: 0, hashed: 0, errors: 0 };
  const bySize = new Map(); // size -> [{path, size, mtimeMs}]

  // Phase 1: enumerate the tree, bucket by file size only.
  for await (const file of walk(rootDir, {
    onError: () => { stats.errors++; },
  })) {
    stats.scanned++;
    if (!bySize.has(file.size)) bySize.set(file.size, []);
    bySize.get(file.size).push(file);
  }
  onProgress(`Scanned ${stats.scanned} files.`);

  // Phase 2: only files sharing a size with >= 1 other file are candidates.
  // Zero-byte files are a special case — they're all "identical" by
  // definition, so skip hashing and group them directly.
  const candidates = [];
  const zeroByteGroup = [];

  for (const [size, files] of bySize.entries()) {
    if (files.length < 2) continue;
    if (size === 0) {
      zeroByteGroup.push(...files);
      continue;
    }
    candidates.push(...files);
  }
  stats.sizeCandidates = candidates.length;
  onProgress(`${candidates.length} files share a size with another file — hashing those.`);

  // Phase 3: hash candidates in parallel, bounded concurrency.
  const byHash = new Map(); // hash -> { size, files: [] }

  await mapWithConcurrency(candidates, concurrency, async (file) => {
    try {
      const digest = await hashFile(file.path, algorithm);
      stats.hashed++;
      const key = digest;
      if (!byHash.has(key)) byHash.set(key, { size: file.size, files: [] });
      byHash.get(key).files.push(file.path);
    } catch (err) {
      stats.errors++;
      onProgress(`Could not hash ${file.path}: ${err.message}`);
    }
  });

  const duplicateGroups = [];

  if (zeroByteGroup.length > 1) {
    duplicateGroups.push({
      hash: '(empty file)',
      size: 0,
      files: zeroByteGroup.map((f) => f.path),
    });
  }

  for (const [hash, group] of byHash.entries()) {
    if (group.files.length > 1) {
      duplicateGroups.push({ hash, size: group.size, files: group.files.sort() });
    }
  }

  // Largest wasted space first.
  duplicateGroups.sort((a, b) => (b.size * (b.files.length - 1)) - (a.size * (a.files.length - 1)));

  return { duplicateGroups, stats };
}

/**
 * Given duplicate groups, decides which files would be deleted and
 * which one would be kept, per group — WITHOUT touching the filesystem.
 * This is the pure decision logic, kept separate from actions.js so
 * it can be unit-tested and used identically by --dry-run and real runs.
 *
 * @param {Array<{hash: string, size: number, files: string[]}>} duplicateGroups
 * @param {'oldest'|'newest'|'first-path'} keepStrategy
 * @param {Map<string, number>} mtimeByPath - path -> mtimeMs, for oldest/newest
 */
export function planDeletions(duplicateGroups, keepStrategy, mtimeByPath) {
  const plan = [];

  for (const group of duplicateGroups) {
    let sortedFiles = [...group.files];

    if (keepStrategy === 'oldest') {
      sortedFiles.sort((a, b) => (mtimeByPath.get(a) ?? 0) - (mtimeByPath.get(b) ?? 0));
    } else if (keepStrategy === 'newest') {
      sortedFiles.sort((a, b) => (mtimeByPath.get(b) ?? 0) - (mtimeByPath.get(a) ?? 0));
    } // 'first-path' keeps existing alphabetical order from findDuplicates

    const [keep, ...remove] = sortedFiles;
    plan.push({ hash: group.hash, size: group.size, keep, remove });
  }

  return plan;
}
