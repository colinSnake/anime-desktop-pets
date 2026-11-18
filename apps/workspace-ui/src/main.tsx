import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./theme.css";
import "./style.css";
import "./chat.css";
import "./models.css";
import "./pages/pages.css";

createRoot(document.getElementById("root")!).render(<App />);
