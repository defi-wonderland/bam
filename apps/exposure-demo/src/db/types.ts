export interface DbMessage {
  id: number;
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  bls_signature: string;
  status: 'pending' | 'posted';
  blob_id: string | null;
  tx_hash: string | null;
  block_number: number | null;
  created_at: string;
}

export interface DbBlob {
  id: string;
  status: 'pending' | 'confirmed' | 'failed';
  tx_hash: string | null;
  block_number: number | null;
  versioned_hash: string | null;
  message_count: number;
  created_at: string;
}
