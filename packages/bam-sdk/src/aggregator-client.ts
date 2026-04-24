/**
 * BAM Aggregator Client
 * @module bam-sdk/aggregator-client
 *
 * This module provides a simple HTTP client for interacting with BAM aggregators.
 *
 * ## Usage
 *
 * ```typescript
 * import { AggregatorClient } from 'bam-core/aggregator-client';
 *
 * const client = new AggregatorClient('https://aggregator.example.com');
 *
 * // Check health
 * const health = await client.health();
 *
 * // Get aggregator info
 * const info = await client.info();
 *
 * // Submit message
 * const message = {
 *   author: '0x...',
 *   timestamp: Date.now() / 1000 | 0,
 *   nonce: 1,
 *   content: 'Hello!',
 *   signature: '0x...',
 *   signatureType: 'bls'
 * };
 * const result = await client.submit(message);
 *
 * // Check status
 * const status = await client.status(result.messageId);
 * ```
 */

import type {
  AggregatorInfo,
  DictionaryInfo,
  HealthStatus,
  MessageStatusResponse,
} from './types.js';

/**
 * Options for aggregator client
 */
export interface AggregatorClientOptions {
  /** Custom fetch implementation (defaults to global fetch) */
  fetch?: typeof fetch;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** API key for authenticated requests */
  apiKey?: string;
  /** Custom headers to include in all requests */
  headers?: Record<string, string>;
}

/**
 * Aggregator error response
 */
export interface AggregatorError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Aggregator API client
 */
export class AggregatorClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeout: number;
  private readonly defaultHeaders: Record<string, string>;

  /**
   * Create a new aggregator client
   * @param baseUrl Base URL of aggregator (e.g., https://aggregator.example.com)
   * @param options Client options
   */
  constructor(baseUrl: string, options: AggregatorClientOptions = {}) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');

    // Use provided fetch or global fetch
    this.fetchFn = options.fetch || globalThis.fetch.bind(globalThis);

    // Timeout (default 30s)
    this.timeout = options.timeout || 30000;

    // Default headers
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'bam-core/0.1.0',
      ...options.headers,
    };

    // Add API key if provided
    if (options.apiKey) {
      this.defaultHeaders['X-API-Key'] = options.apiKey;
    }
  }

  /**
   * Check aggregator health
   * @returns Health status
   */
  async health(): Promise<HealthStatus> {
    const response = await this.request<HealthStatus>('GET', '/health');
    return response;
  }

  /**
   * Get aggregator information and capabilities
   * @returns Aggregator info
   */
  async info(): Promise<AggregatorInfo> {
    const response = await this.request<AggregatorInfo>('GET', '/info');
    return response;
  }

  /**
   * `submit` is not exposed here: callers submit under the ERC-8180
   * primitive layer through a Poster's `/submit` endpoint with the
   * envelope produced by `signECDSA` / `signECDSAWithKey`.
   */

  /**
   * Get message status
   * @param messageId Message ID (0x-prefixed hash)
   * @returns Message status
   */
  async status(messageId: string): Promise<MessageStatusResponse> {
    const response = await this.request<MessageStatusResponse>(
      'GET',
      `/messages/${messageId}/status`
    );
    return response;
  }

  /**
   * List available compression dictionaries
   * @returns Array of dictionary info
   */
  async dictionaries(): Promise<DictionaryInfo[]> {
    const response = await this.request<{ dictionaries: DictionaryInfo[] }>('GET', '/dictionaries');
    return response.dictionaries;
  }

  /**
   * Get a specific dictionary by ID
   * @param dictionaryId Dictionary ID (IPFS CID or hash)
   * @returns Dictionary binary data
   */
  async getDictionary(dictionaryId: string): Promise<Uint8Array> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/dictionaries/${dictionaryId}`,
      {
        method: 'GET',
        headers: this.defaultHeaders,
      }
    );

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * Make an HTTP request to the aggregator API
   * @param method HTTP method
   * @param path API path (without /api/v1 prefix)
   * @param body Request body (optional)
   * @returns Response data
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;

    const options: RequestInit = {
      method,
      headers: this.defaultHeaders,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await this.fetchWithTimeout(url, options);

    if (!response.ok) {
      await this.handleErrorResponse(response);
    }

    return (await response.json()) as T;
  }

  /**
   * Fetch with timeout
   * @param url Request URL
   * @param options Fetch options
   * @returns Response
   */
  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchFn(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Handle error response from aggregator
   * @param response HTTP response
   * @throws Error with aggregator error details
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorBody: { error?: AggregatorError } | null = null;

    try {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        errorBody = (await response.json()) as { error?: AggregatorError };
      }
    } catch (e) {
      // Ignore JSON parse errors
    }

    if (errorBody?.error) {
      const { code, message, details } = errorBody.error;
      throw new AggregatorClientError(code, message, response.status, details);
    } else {
      throw new AggregatorClientError(
        'HTTP_ERROR',
        `HTTP ${response.status}: ${response.statusText}`,
        response.status
      );
    }
  }
}

/**
 * Aggregator client error
 */
export class AggregatorClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(`[${code}] ${message}`);
    this.name = 'AggregatorClientError';
  }
}
