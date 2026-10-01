// Lint is deliberately two rules. `tsc` already enforces unused locals,
// fallthrough, indexed access and exact optionals; what it cannot see is a
// promise nobody awaited, or an async function handed to something that
// ignores what it returns. Both fail silently (a swallowed rejection, a
// callback that "finished" early), which is the failure mode worth a linter in
// a codebase that spawns processes and writes state files. No formatter, no
// style rules.
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**", "dist.tmp/**", "dist.old/**", "coverage/**", "site/**", "plugin/**", "scripts/**"] },
  {
    linterOptions: { reportUnusedDisableDirectives: "off" },
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.test.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // Fake servers in tests hand `createServer` an async handler; a rejection
    // there fails the test through its own timeout, so the rule is kept for src.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    },
  },
];
