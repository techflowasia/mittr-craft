import React from 'react';

type MittrErrorBoundaryProps = { fallback: React.ReactNode; children: React.ReactNode };

type MittrErrorBoundaryState = { failed: boolean };

/**
 * Wraps UI of ours that sits inside the upstream app. A failure in it shows
 * the fallback, usually what upstream would have shown without us, instead
 * of taking the app down with it.
 */
export class MittrErrorBoundary extends React.Component<MittrErrorBoundaryProps, MittrErrorBoundaryState> {
  state: MittrErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): MittrErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.error('[mittr] a MittrCraft part of the UI failed and was set aside:', error);
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
