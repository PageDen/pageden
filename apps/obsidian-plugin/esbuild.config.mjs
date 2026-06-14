import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  minify: true,
  external: ["obsidian"],
  logLevel: "info",
});
