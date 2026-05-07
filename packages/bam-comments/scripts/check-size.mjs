#!/usr/bin/env node
/**
 * Bundle size guard. The widget's gzip budget is 15 kB — anything
 * larger means a regression that needs to be unwound (typically: a
 * stray import dragged the noble curves into the tree).
 */

import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const widget = path.join(here, '..', 'dist', 'widget.js');
const BUDGET_BYTES = 15 * 1024;

const raw = await readFile(widget);
const gz = gzipSync(raw, { level: 9 });
const ratio = (gz.length / BUDGET_BYTES) * 100;

console.log(
  `widget.js  raw=${raw.length} bytes  gzip=${gz.length} bytes  ` +
    `(${ratio.toFixed(1)}% of ${BUDGET_BYTES} budget)`
);

if (gz.length > BUDGET_BYTES) {
  console.error(
    `bundle exceeds 15 kB gzip budget by ${gz.length - BUDGET_BYTES} bytes`
  );
  process.exit(1);
}
