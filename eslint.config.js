import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'coverage/**', 'data/**'] },
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-non-null-assertion': 'off' } },
);
