export const OLLAMA_SETTINGS_KEY = "rigging-studio-ollama-v1";
export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";

export type OllamaSettings = { readonly enabled: boolean; readonly endpoint: string; readonly selectedModel: string | null };
export const DEFAULT_OLLAMA_SETTINGS: OllamaSettings = { enabled: false, endpoint: DEFAULT_OLLAMA_ENDPOINT, selectedModel: null };

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export function parseOllamaSettings(input: unknown): OllamaSettings {
  if (!input || typeof input !== "object") return DEFAULT_OLLAMA_SETTINGS;
  const value = input as Record<string, unknown>;
  return {
    enabled: value.enabled === true,
    endpoint: typeof value.endpoint === "string" ? normalizeOllamaEndpoint(value.endpoint) : DEFAULT_OLLAMA_ENDPOINT,
    selectedModel: typeof value.selectedModel === "string" && value.selectedModel.trim() ? value.selectedModel.trim() : null,
  };
}

export function loadOllamaSettings(storage: KeyValueStorage): OllamaSettings {
  try { return parseOllamaSettings(JSON.parse(storage.getItem(OLLAMA_SETTINGS_KEY) ?? "null")); } catch { return DEFAULT_OLLAMA_SETTINGS; }
}
export function saveOllamaSettings(storage: KeyValueStorage, settings: OllamaSettings): void {
  storage.setItem(OLLAMA_SETTINGS_KEY, JSON.stringify(parseOllamaSettings(settings)));
}

export function normalizeOllamaEndpoint(value: string): string {
  const url = new URL(value.trim() || DEFAULT_OLLAMA_ENDPOINT);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !local) throw new Error("Ollama must use an http:// localhost endpoint");
  url.pathname = url.pathname.replace(/\/+$/, ""); url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}
