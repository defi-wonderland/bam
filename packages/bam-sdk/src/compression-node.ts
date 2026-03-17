/**
 * BAM Compression Utilities — Node-only functions
 * @module bam-sdk/compression-node
 *
 * Functions that depend on Node.js built-in modules (fs, path, crypto).
 * For browser-safe compression utilities, use compression.ts directly.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DICTIONARY_SIZE, DICTIONARY_V1_HASH } from './constants.js';
import { loadDictionary } from './compression.js';
import type { ZstdDictionary } from './compression.js';

/**
 * Load the bundled v1 compression dictionary
 *
 * This dictionary was trained on 10,000 synthetic social messages during
 * Phase 003 compression research (2026-01-27). It provides significant
 * compression improvements:
 * - 9.17x compression ratio (vs 4.62x without dictionary)
 * - 60.6% improvement over baseline
 * - Optimized for typical social message content (50-150 characters)
 *
 * Dictionary details:
 * - Size: 32,768 bytes (32 KB)
 * - Format: Zstd native dictionary
 * - Training corpus: 8,000 messages (80% of 10K corpus)
 * - Validation: 5-fold cross-validation, CV=4.9%
 *
 * @returns Promise resolving to loaded dictionary
 * @throws Error if dictionary file not found or invalid
 *
 * @example
 * ```typescript
 * const dict = await loadBundledDictionary();
 * console.log(`Dictionary ID: ${dict.id}`);
 * console.log(`Dictionary size: ${dict.data.length} bytes`);
 * ```
 */
export async function loadBundledDictionary(): Promise<ZstdDictionary> {
  // Dictionary is bundled at package_root/data/dictionaries/v1.dict
  // From src/: __dirname = .../bam-core/src/ -> ../data/
  // From dist/esm/: __dirname = .../bam-core/dist/esm/ -> ../../data/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const fromSrc = join(__dirname, '..', 'data', 'dictionaries', 'v1.dict');
  const fromDist = join(__dirname, '..', '..', 'data', 'dictionaries', 'v1.dict');

  let dictPath: string;
  try {
    await readFile(fromSrc, { flag: 'r' });
    dictPath = fromSrc;
  } catch {
    dictPath = fromDist;
  }

  // Load dictionary bytes
  const data = await readFile(dictPath);

  // Verify size
  if (data.length !== DICTIONARY_SIZE) {
    throw new Error(`Dictionary size mismatch: expected ${DICTIONARY_SIZE}, got ${data.length}`);
  }

  // Verify hash for integrity
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== DICTIONARY_V1_HASH) {
    throw new Error(`Dictionary hash mismatch: expected ${DICTIONARY_V1_HASH}, got ${hash}`);
  }

  // Load and validate
  return loadDictionary(new Uint8Array(data));
}

/**
 * Load a compression dictionary from a file path
 *
 * @param path Path to dictionary file
 * @returns Promise resolving to loaded dictionary
 * @throws Error if file not found or invalid
 *
 * @example
 * ```typescript
 * const dict = await loadDictionaryFromFile('./custom-dict.zdict');
 * ```
 */
export async function loadDictionaryFromFile(path: string): Promise<ZstdDictionary> {
  const data = await readFile(path);
  return loadDictionary(new Uint8Array(data));
}
