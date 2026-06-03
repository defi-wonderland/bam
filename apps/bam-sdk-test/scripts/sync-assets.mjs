import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

copyFileSync(
  resolve(__dirname, '../../../packages/bam-sdk/data/dictionaries/bpe-v1.bin'),
  resolve(__dirname, '../public/bpe-v1.bin'),
);
