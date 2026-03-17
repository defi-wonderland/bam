export interface DbMessage {
  id: number;
  message_id: string;
  author: string;
  timestamp: number;
  nonce: number;
  content: string;
  signature: string;
  status: 'pending' | 'posted';
  blobble_id: string | null;
  created_at: string;
}

export interface DbBlobble {
  id: string;
  status: 'pending' | 'confirmed' | 'failed';
  tx_hash: string | null;
  block_number: number | null;
  message_count: number;
  created_at: string;
}
