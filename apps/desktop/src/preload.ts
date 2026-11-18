import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../../../packages/contracts/src/index.ts";

const bridge: DesktopBridge = Object.freeze({
  pets: Object.freeze({
    list: () => ipcRenderer.invoke("pet:pets-list"),
    importPackages: () => ipcRenderer.invoke('pet:pets-importPackages'),
    start: (input) => ipcRenderer.invoke("pet:pets-start", input),
    stop: (input) => ipcRenderer.invoke("pet:pets-stop", input),
    applyDisplayPreferences: (input) => ipcRenderer.invoke("pet:pets-applyDisplay", input),
    applyBehaviorPreferences: (input) => ipcRenderer.invoke("pet:pets-applyBehavior", input),
    setVisible: (input) => ipcRenderer.invoke("pet:pets-visibility", input),
    add: (input) => ipcRenderer.invoke("pet:pets-add", input),
    clone: (input) => ipcRenderer.invoke("pet:pets-clone", input),
    delete: (input) => ipcRenderer.invoke("pet:pets-delete", input),
    save: (input) => ipcRenderer.invoke("pet:pets-save", input),
    setTheme: (input) => ipcRenderer.invoke("pet:pets-theme", input),
    pause: (input) => ipcRenderer.invoke("pet:pets-pause", input),
    resume: (input) => ipcRenderer.invoke("pet:pets-resume", input),
  } satisfies NonNullable<DesktopBridge["pets"]>),
  snapshot: () => ipcRenderer.invoke("pet:snapshot"),
  probeRuntime: () => ipcRenderer.invoke("pet:probe-runtime"),
  startPlayer: () => ipcRenderer.invoke("pet:start-player"),
  stopPlayer: () => ipcRenderer.invoke("pet:stop-player"),
});
contextBridge.exposeInMainWorld("petDesktop", bridge);
