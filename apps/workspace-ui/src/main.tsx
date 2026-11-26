import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./theme.css";
import "./style.css";
import "./pet-nook.css";
import "./image-preview.css";

createRoot(document.getElementById("root")!).render(<App />);
