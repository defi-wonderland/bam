import { privateKeyToAccount } from 'viem/accounts';
import type { Account } from 'viem';

import type { Signer } from '../types.js';

/**
 * Default local-key signer. Holds the viem `Account` returned by
 * `privateKeyToAccount` — the raw 32-byte private key is consumed
 * at construction time and never exposed again.
 *
 * `toString` / `toJSON` are pinned so that an accidental log /
 * serialization of the signer or its account never surfaces private
 * material (G-6, plan §Signer-leak).
 */
export class LocalEcdsaSigner implements Signer {
  private readonly _account: Account;

  constructor(privateKey: `0x${string}`) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error('LocalEcdsaSigner: invalid private key shape');
    }
    this._account = privateKeyToAccount(privateKey);
  }

  account(): Account {
    return this._account;
  }

  /** Hide the key on any stringification. */
  toString(): string {
    return `LocalEcdsaSigner(${this._account.address})`;
  }

  toJSON(): unknown {
    return { kind: 'LocalEcdsaSigner', address: this._account.address };
  }
}
