interface ImportMetaEnv {
  readonly VITE_BACKEND?: 'memory' | 'supabase' | 'rest';
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
