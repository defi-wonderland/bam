#!/usr/bin/env npx tsx
/**
 * Save deployment addresses from Forge broadcast output.
 *
 * Usage:
 *   npx tsx scripts/save-deployment.ts [script-name] [chain-id]
 *
 * Examples:
 *   npx tsx scripts/save-deployment.ts Deploy.s.sol 11155111
 *   npx tsx scripts/save-deployment.ts Deploy.s.sol 1
 *
 * Reads the latest broadcast run from bam-contracts/broadcast/<script>/<chainId>/run-latest.json
 * and writes a deployment file to bam-contracts/deployments/<chainId>.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const contractsDir = join(root, 'packages', 'bam-contracts');

interface BroadcastTx {
  transactionType: string;
  contractName: string | null;
  contractAddress: string | null;
}

interface BroadcastRun {
  transactions: BroadcastTx[];
}

interface DeploymentContract {
  address: string;
}

interface Deployment {
  chainId: number;
  name: string;
  timestamp: string;
  contracts: Record<string, DeploymentContract>;
}

const CHAIN_NAMES: Record<number, string> = {
  1: 'mainnet',
  11155111: 'sepolia',
  17000: 'holesky',
  31337: 'local',
};

function main() {
  const scriptName = process.argv[2] || 'Deploy.s.sol';
  const chainId = parseInt(process.argv[3] || '', 10);

  if (!chainId) {
    console.error('Usage: npx tsx scripts/save-deployment.ts <script-name> <chain-id>');
    console.error('Example: npx tsx scripts/save-deployment.ts Deploy.s.sol 11155111');
    process.exit(1);
  }

  const broadcastPath = join(contractsDir, 'broadcast', scriptName, String(chainId), 'run-latest.json');

  if (!existsSync(broadcastPath)) {
    console.error(`Broadcast file not found: ${broadcastPath}`);
    console.error('Run the deploy script first: forge script script/Deploy.s.sol --broadcast');
    process.exit(1);
  }

  const raw = readFileSync(broadcastPath, 'utf-8');
  const broadcast = JSON.parse(raw) as BroadcastRun;

  const contracts: Record<string, DeploymentContract> = {};

  for (const tx of broadcast.transactions) {
    if (tx.transactionType === 'CREATE' && tx.contractName && tx.contractAddress) {
      contracts[tx.contractName] = {
        address: tx.contractAddress,
      };
    }
  }

  if (Object.keys(contracts).length === 0) {
    console.error('No contract deployments found in broadcast.');
    process.exit(1);
  }

  const deployment: Deployment = {
    chainId,
    name: CHAIN_NAMES[chainId] || `chain-${chainId}`,
    timestamp: new Date().toISOString(),
    contracts,
  };

  const outputPath = join(contractsDir, 'deployments', `${chainId}.json`);
  writeFileSync(outputPath, JSON.stringify(deployment, null, 2) + '\n');

  console.log(`Saved ${Object.keys(contracts).length} contract addresses to ${outputPath}`);
  for (const [name, info] of Object.entries(contracts)) {
    console.log(`  ${name}: ${info.address}`);
  }
}

main();
