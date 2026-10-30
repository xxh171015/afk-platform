import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ApiProvider, defaultClient } from "./api.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("no #root element");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <ApiProvider client={defaultClient()}>
        <App />
      </ApiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
