// OpenRouter model catalog, shown inline under each model picker in Settings
// (an inline disclosure, not a modal).
//
// Constraints:
// - Nothing is requested until the user presses Fetch (or Try again): the
//   only call to api.listOpenRouterModels is in fetchCatalog, which runs from
//   those buttons, never from an effect. Opening Settings or expanding the
//   disclosure sends nothing.
// - The request goes through the Rust command (keychain key, fixed URL); the
//   endpoint passed is the form's current value and only gates the call. The
//   command also requires the SAVED endpoint to be OpenRouter and uses the
//   SAVED key (security-rust-1), so Settings passes `fetchBlock`
//   (catalogFetchBlock in openRouterModels.ts): while it is non-null, Fetch
//   and Try again are disabled with the reason shown inline next to Fetch,
//   and fetchCatalog returns before calling the API.
// - A failed or in-flight refresh keeps the previous list (catalog reducer in
//   openRouterModels.ts), and the error stays inline with a retry until the
//   next success.
// - Selecting a row only calls onSelect(id); Settings applies it through
//   applyModelSelection and nothing is persisted until Save.
// - The backend's error text is English; localizeCatalogError
//   (exportWarnings.ts) renders the known messages in the UI language at the
//   catch site, and unknown messages are shown unchanged.

import { useCallback, useId, useRef, useState } from "react";
import { api } from "../api";
import { localizeCatalogError } from "../exportWarnings";
import { interpolate, useLang, useT } from "../i18n";
import {
  catalogFailed,
  catalogLoaded,
  catalogLoading,
  DEFAULT_CATALOG_FILTERS,
  EMPTY_CATALOG_STATE,
  filterCatalog,
  formatCatalogPrice,
  formatContextLength,
  hasOutputModality,
  isOpenRouterEndpoint,
  type CatalogFetchBlock,
  type CatalogKind,
  type CatalogState,
} from "../openRouterModels";

export interface OpenRouterCatalogHandle {
  state: CatalogState;
  fetchCatalog: () => Promise<void>;
}

/** Session-scoped catalog shared by the text and image pickers. Call it from
 *  a component that stays mounted (SettingsModal) so one fetch serves both. */
export function useOpenRouterCatalog(endpoint: string, block: CatalogFetchBlock | null): OpenRouterCatalogHandle {
  const [state, setState] = useState<CatalogState>(EMPTY_CATALOG_STATE);
  const lang = useLang();
  const inFlight = useRef(false);
  const fetchCatalog = useCallback(async () => {
    if (inFlight.current || block !== null || !isOpenRouterEndpoint(endpoint)) return;
    inFlight.current = true;
    setState(catalogLoading);
    try {
      const catalog = await api.listOpenRouterModels(endpoint);
      setState((s) => catalogLoaded(s, catalog));
    } catch (e) {
      const message = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setState((s) => catalogFailed(s, localizeCatalogError(message, lang)));
    } finally {
      inFlight.current = false;
    }
  }, [endpoint, block, lang]);
  return { state, fetchCatalog };
}

interface Props {
  kind: CatalogKind;
  catalog: OpenRouterCatalogHandle;
  /** Why Fetch is unavailable (catalogFetchBlock), or null when it is. */
  fetchBlock: CatalogFetchBlock | null;
  activeModel: string;
  onSelect: (id: string) => void;
  /** Start expanded, scrolled into view, with Fetch focused (palette entry). */
  autoOpen?: boolean;
}

export default function OpenRouterModelCatalog({
  kind,
  catalog,
  fetchBlock,
  activeModel,
  onSelect,
  autoOpen = false,
}: Props) {
  const t = useT();
  const panelId = useId();
  const reasonId = useId();
  const [expanded, setExpanded] = useState(autoOpen);
  // A ref callback, not an effect (this component never runs effects — see
  // openRouterModels.test.ts): on mount with autoOpen, bring Fetch into view
  // and focus it. Nothing is fetched until the user presses it.
  const fetchButton = useCallback(
    (el: HTMLButtonElement | null) => {
      if (el && autoOpen) {
        el.scrollIntoView({ block: "center" });
        el.focus();
      }
    },
    [autoOpen]
  );
  const [query, setQuery] = useState(DEFAULT_CATALOG_FILTERS.query);
  const [freeOnly, setFreeOnly] = useState(DEFAULT_CATALOG_FILTERS.freeOnly);
  const { state, fetchCatalog } = catalog;
  const loading = state.status === "loading";
  // Endpoint or key edited but not saved: the backend would use the saved
  // ones, so Fetch / Try again wait for Save (the loaded list stays usable).
  const blockReason =
    fetchBlock === "endpoint-unsaved"
      ? t("Save the endpoint first to load the OpenRouter list.")
      : fetchBlock === "key-unsaved"
        ? t("Save the API key first to load the OpenRouter list.")
        : null;
  const blocked = blockReason !== null;

  const fetchAndOpen = () => {
    setExpanded(true);
    void fetchCatalog();
  };

  const fetchLabel = loading
    ? t("Loading model catalog…")
    : state.loaded
      ? t("Refresh model list")
      : t("Fetch OpenRouter models");

  const smallBtn =
    "rounded-md border border-ink-faint/40 px-2.5 py-1 text-xs text-ink-soft hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-50";

  if (fetchBlock === "custom-endpoint") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled
          className={smallBtn}
          title={t("Use manual model IDs with a custom endpoint.")}
        >
          {t("Fetch OpenRouter models")}
        </button>
        <span className="text-xs text-ink-faint">{t("Use manual model IDs with a custom endpoint.")}</span>
      </div>
    );
  }

  const ofKind = state.models.filter((m) => hasOutputModality(m, kind));
  const shown = filterCatalog(state.models, kind, query, freeOnly);

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="text-xs font-medium text-accent hover:text-accent-soft"
        >
          <span aria-hidden="true" className="mr-1 inline-block w-2">
            {expanded ? "▾" : "▸"}
          </span>
          {t("Browse OpenRouter models")}
        </button>
        <button
          ref={fetchButton}
          type="button"
          onClick={fetchAndOpen}
          disabled={loading || blocked}
          aria-busy={loading || undefined}
          aria-describedby={blockReason ? reasonId : undefined}
          className={smallBtn}
        >
          {fetchLabel}
        </button>
        {blockReason && (
          <span id={reasonId} className="text-xs text-ink-faint">
            {blockReason}
          </span>
        )}
      </div>

      {expanded && (
        <div id={panelId} className="mt-2 space-y-2 rounded-md border border-ink-faint/30 p-2">
          {!state.loaded && state.status === "idle" && (
            <p className="text-xs text-ink-faint">
              {t("Nothing is sent to OpenRouter until you fetch the list.")}
            </p>
          )}

          {!state.loaded && loading && (
            <p className="text-xs text-ink-faint" aria-live="polite">
              {t("Loading model catalog…")}
            </p>
          )}

          {state.status === "error" && (
            <div role="alert" className="rounded-md border border-danger-line bg-danger-wash px-2 py-1.5 text-xs">
              <p className="font-medium text-danger">{t("Model catalog could not be loaded.")}</p>
              {state.error && <p className="mt-0.5 break-words text-ink-soft">{state.error}</p>}
              <button
                type="button"
                onClick={fetchAndOpen}
                disabled={blocked}
                aria-describedby={blockReason ? reasonId : undefined}
                className={`${smallBtn} mt-1.5`}
              >
                {t("Try again")}
              </button>
            </div>
          )}

          {state.loaded && state.skipped > 0 && (
            <p className="text-xs text-warn-strong">
              {interpolate(t("{n} catalog entries could not be read and were skipped."), {
                n: state.skipped,
              })}
            </p>
          )}

          {state.loaded && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("Search models by name or ID")}
                  aria-label={t("Search models by name or ID")}
                  className="min-w-0 flex-1 rounded-md border border-ink-faint/40 px-2 py-1 text-sm outline-none focus:border-accent"
                />
                <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                  <input
                    type="checkbox"
                    checked={freeOnly}
                    onChange={(e) => setFreeOnly(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  {t("Free only")}
                </label>
                <span className="text-xs text-ink-faint" aria-live="polite">
                  {interpolate(t("{shown} of {total} models"), { shown: shown.length, total: ofKind.length })}
                </span>
              </div>

              {state.models.length === 0 ? (
                <p className="text-xs text-ink-faint">{t("OpenRouter returned an empty model list.")}</p>
              ) : shown.length === 0 ? (
                <p className="text-xs text-ink-faint">{t("No models match these filters.")}</p>
              ) : (
                <ul className="max-h-60 space-y-0.5 overflow-auto" aria-label={t("Browse OpenRouter models")}>
                  {shown.map((m) => {
                    const isActive = m.id === activeModel;
                    const context = formatContextLength(m.contextLength);
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(m.id)}
                          aria-pressed={isActive}
                          title={m.id}
                          className={`w-full rounded px-2 py-1.5 text-left ${
                            isActive ? "bg-accent/10" : "hover:bg-accent/5"
                          }`}
                        >
                          <span className="block truncate text-sm font-medium text-ink">
                            <span aria-hidden="true" className="mr-1 inline-block w-3 text-accent">
                              {isActive ? "✓" : ""}
                            </span>
                            {m.name}
                          </span>
                          {m.name !== m.id && (
                            <span className="ml-4 block truncate font-mono text-xs text-ink-faint">{m.id}</span>
                          )}
                          <span className="ml-4 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-soft">
                            <span>{formatCatalogPrice(m, t)}</span>
                            {context && <span>{interpolate(t("{n} context"), { n: context })}</span>}
                            {hasOutputModality(m, "text") && (
                              <span className="rounded bg-chrome-hairline px-1 text-ink-soft">{t("Text output")}</span>
                            )}
                            {hasOutputModality(m, "image") && (
                              <span className="rounded bg-chrome-hairline px-1 text-ink-soft">{t("Image output")}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
