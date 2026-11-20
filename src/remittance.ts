
import { createClient } from '@supabase/supabase-js';

export async function getRemittanceRate() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error('Supabase is not configured');
  }

  const supabase = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data, error } = await supabase
    .from('remittance_rates')
    .select(
      'provider,currency_from,currency_to,rate,source,verified_at'
    )
    .eq('currency_from', 'KRW')
    .eq('currency_to', 'MMK')
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error('Unable to load remittance rate');
  if (!data) return null;

  return {
    provider: data.provider,
    from: data.currency_from,
    to: data.currency_to,
    rate: String(data.rate),
    source: data.source,
    verifiedAt: data.verified_at,
  };
}
