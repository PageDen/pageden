export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in unit tests; inject a RequestTransport.");
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class Notice {}
export class TFile {}
