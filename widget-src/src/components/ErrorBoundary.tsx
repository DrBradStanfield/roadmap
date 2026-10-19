import React from 'react';
import { Sentry } from '../lib/sentry';

interface Props {
  children: React.ReactNode;
  /** Shown instead of the whole-tool message, for one part of the page. */
  fallback?: React.ReactNode;
  /** With `fallback`: the Sentry tag naming that part. Only the error goes,
   *  through the scrubbed path, never the component stack or props. */
  feature?: string;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Health tool error:', error, info.componentStack);
    Sentry.captureException(error, this.props.feature ? { tags: { feature: this.props.feature } } : { extra: { componentStack: info.componentStack } });
  }

  render() {
    if (this.state.hasError && this.props.fallback) return this.props.fallback;
    if (this.state.hasError) {
      return (
        <div className="health-tool-error">
          <h3>Something went wrong</h3>
          <p>The health tool encountered an error. Please refresh the page to try again.</p>
          <p style={{ marginTop: '8px', fontSize: '14px' }}>
            <a href="mailto:brad@drstanfield.com?subject=Health%20Roadmap%20Bug%20Report">Report this issue</a>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
