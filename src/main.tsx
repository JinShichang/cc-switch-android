import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./i18n";
import "./upstream/index.css";
import { initializeInputModality } from "./lib/inputModality";
initializeInputModality();
import "./styles.css";

class Boundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="startup-error">
        <h1>界面暂时无法显示</h1>
        <p>请关闭后重新打开 CC Switch。本地方案不会被重置。</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <Boundary>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster richColors position="top-center" />
    </QueryClientProvider>
  </Boundary>,
);
