import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'android/**', 'node_modules/**'],
  },
  js.configs.recommended,
  { files: ['tools/**/*.mjs', 'tests/**/*.mjs'], languageOptions: { globals: globals.node } },
  {
    files: ['src/**/*.js', 'public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['supabase/functions/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        Deno: 'readonly',
        Response: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        btoa: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
];
