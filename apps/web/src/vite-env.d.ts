/// <reference types="vite/client" />

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export function gfm(turndownService: TurndownService): void;
  export function tables(turndownService: TurndownService): void;
  export function strikethrough(turndownService: TurndownService): void;
  export function taskListItems(turndownService: TurndownService): void;
  export function highlightedCodeBlock(turndownService: TurndownService): void;
}
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WORKSPACE_BASE_DOMAIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
