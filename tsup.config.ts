import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/tui/main.tsx"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // The TUI entry (main.tsx) pulls in React's type graph; generating .d.ts for it
  // is pointless (it's an internal entry, not a public API) and slow. Keep dts for
  // the library surface only.
  dts: { entry: { index: "src/index.ts", cli: "src/cli.ts" } },
  sourcemap: true,
});
