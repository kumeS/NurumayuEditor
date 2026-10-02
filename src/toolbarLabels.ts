// Pure label builders for toolbar controls whose copy interpolates values, so
// they cannot be a single dictionary key (UX-label-model). Tested in
// toolbarLabels.test.ts, which also guards the Toolbar wiring.

/**
 * Tooltip AND accessible name of the toolbar settings button: the active model
 * when an API key is stored, otherwise a prompt to configure one.
 */
export function settingsButtonLabel(
  model: string,
  hasKey: boolean,
  t: (key: string) => string
): string {
  if (!hasKey) return t("API key not set — click to configure");
  return `${t("Model")}: ${model || t("(default)")}`;
}
