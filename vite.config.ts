import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Root-relative, so the config needs no Node path APIs; tsconfig.json mirrors it in "paths".
    alias: { '@': '/src' },
  },
});
