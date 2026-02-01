import React from 'react';

interface Props {
  children: React.ReactNode;
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
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="health-tool-error">
          <h3>Something went wrong</h3>
          <p>The health tool encountered an error. Please refresh the page to try again.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
