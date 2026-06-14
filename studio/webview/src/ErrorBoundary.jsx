import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Architecture Canvas crashed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error?.message || String(this.state.error);
    return (
      <div className="webview-error">
        <h1>Architecture Canvas could not render</h1>
        <p>{message}</p>
        <p>Close and reopen this tab after installing a new build. If it still happens, open Webview Developer Tools and send the console error.</p>
      </div>
    );
  }
}
