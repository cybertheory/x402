import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
}

export interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirement[];
  error?: string;
  resource?: {
    uri: string;
    method?: string;
  };
}

export interface WalletPayResponse {
  success: boolean;
  signature: string;
  wallet_id: string;
  wallet_address: string;
}

/**
 * Call the wallet-pay edge function to create an x402 payment signature
 */
export async function createPaymentSignature(
  supabaseUrl: string,
  apiKey: string,
  paymentRequired: PaymentRequired,
  walletId?: string
): Promise<string> {
  // Create Supabase client with API key in headers
  const supabase = createClient(supabaseUrl, '', {
    global: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });

  const { data, error } = await supabase.functions.invoke('wallet-pay', {
    body: {
      wallet_id: walletId,
      paymentRequired,
    },
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (error) {
    throw new Error(`Failed to create payment signature: ${error.message}`);
  }

  const response = data as WalletPayResponse;
  if (!response.success || !response.signature) {
    throw new Error('Invalid response from wallet-pay function');
  }

  return response.signature;
}

