import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as pay from './pay';

export interface X402InstantClientConfig {
  apiKey: string;
  supabaseUrl: string;
  walletId?: string;
}

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | object;
  walletId?: string;
}

/**
 * X402Instant Client - Automatically handles x402 payments in HTTP requests
 */
export class X402InstantClient {
  private apiKey: string;
  private supabaseUrl: string;
  private defaultWalletId?: string;

  constructor(config: X402InstantClientConfig) {
    this.apiKey = config.apiKey;
    this.supabaseUrl = config.supabaseUrl;
    this.defaultWalletId = config.walletId;
  }

  /**
   * Get the API key for authentication
   * The API key is used directly - no JWT conversion needed
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Create a payment signature using the wallet-pay edge function
   */
  async createSignature(
    paymentRequired: pay.PaymentRequired,
    walletId?: string
  ): Promise<string> {
    const apiKey = this.getApiKey();
    const targetWalletId = walletId || this.defaultWalletId;
    return pay.createPaymentSignature(
      this.supabaseUrl,
      apiKey,
      paymentRequired,
      targetWalletId
    );
  }

  /**
   * Make an HTTP request and automatically handle x402 payment challenges
   */
  async call(url: string, options: CallOptions = {}): Promise<Response> {
    const method = options.method || 'GET';
    const headers = new Headers(options.headers || {});
    const body = options.body
      ? typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
      : undefined;

    // Make initial request
    let response = await fetch(url, {
      method,
      headers,
      body,
    });

    // Check for 402 Payment Required
    if (response.status === 402) {
      // Parse PaymentRequired from response
      const paymentRequiredHeader =
        response.headers.get('PAYMENT-REQUIRED') ||
        response.headers.get('X-PAYMENT-REQUIRED');

      let paymentRequired: pay.PaymentRequired;

      if (paymentRequiredHeader) {
        try {
          // Try to parse as base64 JSON first
          const decoded = atob(paymentRequiredHeader);
          paymentRequired = JSON.parse(decoded);
        } catch {
          // If not base64, try direct JSON
          try {
            paymentRequired = JSON.parse(paymentRequiredHeader);
          } catch {
            // If header parsing fails, try response body
            const bodyText = await response.text();
            try {
              paymentRequired = JSON.parse(bodyText);
            } catch {
              throw new Error('Failed to parse PaymentRequired from 402 response');
            }
          }
        }
      } else {
        // Try to parse from response body
        const bodyText = await response.text();
        try {
          paymentRequired = JSON.parse(bodyText);
        } catch {
          throw new Error('Failed to parse PaymentRequired from 402 response');
        }
      }

      // Ensure resource is set
      if (!paymentRequired.resource) {
        paymentRequired.resource = {
          uri: url,
          method: method,
        };
      }

      // Create payment signature
      const paymentSignature = await this.createSignature(
        paymentRequired,
        options.walletId
      );

      // Retry request with payment signature
      const paymentHeaders = new Headers(headers);
      paymentHeaders.set('PAYMENT-SIGNATURE', paymentSignature);

      response = await fetch(url, {
        method,
        headers: paymentHeaders,
        body,
      });
    }

    return response;
  }

  /**
   * Pay package - provides payment-related methods
   */
  get pay() {
    return {
      createSignature: (paymentRequired: pay.PaymentRequired, walletId?: string) =>
        this.createSignature(paymentRequired, walletId),
    };
  }
}

