import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Computes a content hash of a file by streaming it through the
 * hash algorithm in chunks, instead of reading the whole file into
 * memory with readFileSync. This is what makes the tool safe to run
 * on multi-GB files (video, disk images, VM snapshots, etc.).
 *
 * @param {string} filePath
 * @param {string} algorithm - 'md5' | 'sha1' | 'sha256'
 * @returns {Promise<string>} hex digest
 */
export function hashFile(filePath, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 }); // 1MB chunks

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Runs an async worker over a list of items with bounded concurrency.
 * Used so we hash many files in parallel (I/O-bound) without opening
 * thousands of file descriptors at once on large trees.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, runOne);
  await Promise.all(runners);
  return results;
}
