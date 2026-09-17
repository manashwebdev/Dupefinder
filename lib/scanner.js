import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Recursively walks a directory tree and yields file descriptors.
 *
 * Implemented as an async generator so callers can start hashing
 * as soon as the first file is found, rather than waiting for the
 * whole tree to be enumerated in memory.
 *
 * Symlinks are deliberately NOT followed — this avoids infinite loops
 * on cyclic symlinks and matches the "safe by default" posture of
 * the whole tool.
 *
 * @param {string} rootDir - directory to scan
 * @param {object} [opts]
 * @param {(err: Error, path: string) => void} [opts.onError] - called on
 *   unreadable dirs/files (permission errors, broken symlinks, etc.)
 *   instead of throwing, so one bad entry doesn't kill the whole scan.
 * @yields {{ path: string, size: number, mtimeMs: number }}
 */
export async function* walk(rootDir, opts = {}) {
  const { onError = () => {} } = opts;

  async function* recurse(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      onError(err, dir);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        continue; // skip symlinks entirely: never follow, never hash
      }

      if (entry.isDirectory()) {
        yield* recurse(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue; // skip sockets, FIFOs, device files, etc.
      }

      try {
        const stats = await lstat(fullPath);
        yield { path: fullPath, size: stats.size, mtimeMs: stats.mtimeMs };
      } catch (err) {
        onError(err, fullPath);
      }
    }
  }

  yield* recurse(rootDir);
}
