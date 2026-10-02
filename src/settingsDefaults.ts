// Frontend fallback settings, used by the Settings dialog before the backend's
// settings have loaded and when a stored model list is empty.
//
// Constraints:
// - Rust `Settings` (src-tauri/src/settings.rs) is the source of truth. The
//   model lists here equal `default_models()` / `default_image_models()`, and
//   endpoint / model / imageModel equal DEFAULT_ENDPOINT / DEFAULT_MODEL /
//   DEFAULT_IMAGE_MODEL; settingsDefaults.test.ts raw-reads settings.rs to
//   keep both sides in step.
// - A slug the provider retires is removed on BOTH sides (BUG-013a:
//   "meta-llama/llama-3.3-70b-instruct:free"). Removal only stops seeding; a
//   copy already saved in a user's list is kept, never auto-deleted.

import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model: "deepseek/deepseek-v4-flash",
  models: [
    "deepseek/deepseek-v4-flash",
    "qwen/qwen3.6-flash",
    "meta-llama/llama-4-maverick",
    "moonshotai/kimi-k2.5",
    "google/gemma-4-31b-it:free",
    "deepseek/deepseek-r1:free",
  ],
  imageModel: "google/gemini-2.5-flash-image",
  imageModels: [
    "google/gemini-2.5-flash-image",
    "x-ai/grok-imagine-image-quality",
    "recraft/recraft-v4-pro",
    "openai/gpt-5.4-image-2",
    "black-forest-labs/flux.2-klein-4b",
    "google/gemini-3-pro-image-preview",
  ],
  defaultTargetLanguage: "English",
  writingTone: "",
  temperature: 0.3,
  editorFontFamily: "serif",
  editorFontSize: 17,
  removedModels: [],
  limitCompletionToLocalModel: false,
  charLimitWarning: undefined,
  personalRagEnabled: false,
  mcpWriteEnabled: false,
};
