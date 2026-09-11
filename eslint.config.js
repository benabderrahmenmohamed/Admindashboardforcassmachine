import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // supabase/functions is Deno code from the Figma Make export; it is deleted once the app
  // talks to tables and RPCs directly.
  globalIgnores(['dist', 'coverage', 'supabase/functions']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat['recommended-latest'],
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Effect-based data loading kept from the Figma Make export. The rule cannot see that the
    // setState calls happen after an await, so every loader called from a mount effect is
    // flagged. These pages move to TanStack Query next, which removes the pattern and this block.
    files: ['src/app/pages/Categories.tsx', 'src/app/pages/POS.tsx', 'src/app/pages/Products.tsx'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
]);
