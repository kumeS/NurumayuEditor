// Catches render/runtime errors in the editor subtree so a single component
// fault shows a recoverable message instead of white-screening (or appearing to
// "crash") the whole app. Reset it by switching tab/mode (the key changes) or the
// "Try again" button.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { tNow } from "../i18n";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaced in the devtools/console for diagnosis.
    console.error("Editor view crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-lg font-semibold text-ink">
            {tNow("Something went wrong in this view")}
          </div>
          <div className="max-w-md break-words text-sm text-ink-faint">
            {error.message || String(error)}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-ink-soft hover:bg-gray-100"
          >
            {tNow("Try again")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
