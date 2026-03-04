import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "./lib/query-provider.js";
import { ToastProvider } from "./lib/toast-provider.js";
import { App } from "./app.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryProvider>
  </StrictMode>,
);
