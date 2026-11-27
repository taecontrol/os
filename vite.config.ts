import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
  },
  lint: {
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
    ignorePatterns: ["dist/**"],
    jsPlugins: ["./lint/no-comments.ts"],
    rules: {
      "os/no-comments": "error",
    },
  },
  fmt: {
    ignorePatterns: ["dist/**"],
  },
});
