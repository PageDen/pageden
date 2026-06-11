import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const vault = process.env.OBSIDIAN_VAULT;
if (!vault) {
  console.error("Set OBSIDIAN_VAULT to the absolute path of the test vault.");
  process.exit(1);
}

const pluginDir = join(vault, ".obsidian", "plugins", "pageden");
const files = ["manifest.json", "main.js", "styles.css"];

for (const file of files) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run pnpm --filter @pageden/obsidian-plugin build first.`);
    process.exit(1);
  }
}

await mkdir(pluginDir, { recursive: true });
for (const file of files) {
  await copyFile(file, join(pluginDir, file));
}

console.log(`Installed Pageden plugin to ${pluginDir}`);
