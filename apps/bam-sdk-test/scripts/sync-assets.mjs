import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dest = resolve(__dirname, '../public/bpe-v1.bin');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(
  resolve(__dirname, '../../../packages/bam-sdk/data/dictionaries/bpe-v1.bin'),
  dest,
);
