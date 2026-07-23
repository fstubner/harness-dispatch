import { defineConfig } from "astro/config";

// Project Pages URL after the repo rename (harness-router -> harness-dispatch).
// The Pages workflow is manual (workflow_dispatch) and only runs post-rename,
// so the base never serves under the old name.
export default defineConfig({
  site: "https://fstubner.github.io",
  base: "/harness-dispatch",
});
