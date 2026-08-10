import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

/**
 * Browser Supabase client, used only to push files to Storage with a signed
 * upload token minted server-side. Carries the public anon key — it grants
 * nothing on its own; each upload is authorised by its own short-lived token.
 */
export function getSupabaseBrowser(): SupabaseClient {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) {
      throw new Error(
        "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Add both to your environment to enable folder import."
      );
    }
    _client = createClient(url, key);
  }
  return _client;
}
