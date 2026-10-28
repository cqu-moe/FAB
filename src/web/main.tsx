import { createRoot } from "react-dom/client";
import { ThemeProvider, Toaster } from "@cqu-moe/ui";
import App from "./App";
import "@cqu-moe/theme/styles.css";
import "@cqu-moe/ui/styles.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
    <Toaster />
  </ThemeProvider>,
);
