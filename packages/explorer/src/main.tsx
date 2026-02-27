import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./lib/use-toasts.js";
import { App } from "./app.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
