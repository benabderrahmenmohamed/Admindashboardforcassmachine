function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing ${name}: copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const env = {
  supabaseUrl: required('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL).replace(/\/+$/, ''),
  supabaseAnonKey: required('VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY),
};

// The Figma Make edge function that currently serves all catalog, settings and order data.
export const edgeFunctionUrl = `${env.supabaseUrl}/functions/v1/make-server-81f0b18a`;
