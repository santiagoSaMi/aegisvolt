// Configuración ESLint (flat config) del monorepo.
// - typescript-eslint con reglas "type-checked" (projectService usa el tsconfig de cada paquete).
// - Reglas de React solo en apps/web.
// - eslint-config-prettier al final: ESLint no opina sobre formato (lo hace Prettier).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    '**/coverage/',
    '**/.vite/',
    '**/.tmp/',
    '**/.terraform/',
    'infra/local/floci/data/',
    'prefect/',
  ]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
      // Los servicios registran con @aegisvolt/logger (JSON estructurado), nunca con console.
      'no-console': 'error',
    },
  },

  // Archivos JavaScript de configuración: sin reglas que requieren tipos.
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // Código Node.js (servicios, API y paquetes).
  {
    files: ['apps/graphql-api/**/*.ts', 'services/**/*.ts', 'packages/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // Frontend React.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },

  // Pruebas: se permiten aserciones no-null en fixtures.
  {
    files: ['**/test/**/*.ts', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  prettier,
);
