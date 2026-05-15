// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "build/**",
      ".react-router/**",
      "node_modules/**",
      "drizzle/**",
      "playwright-report/**",
      "test-results/**",
      "*.cjs",
      "postcss.config.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
  {
    files: ["dev.mjs", "tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Playwright fixtures use empty `{}` destructuring + a `use` callback
    // that linters mistake for a React hook. Neither rule applies in tests.
    files: ["tests/**/*.ts"],
    rules: {
      "no-empty-pattern": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },
);
