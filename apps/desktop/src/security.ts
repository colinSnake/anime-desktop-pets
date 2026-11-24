export const WORKSPACE_URL = "pet-app://workspace/index.html";
export const MICROPHONE_WORKLET_ASSET = 'assets/microphone-worklet.js';
export const MICROPHONE_WORKLET_URL = `pet-app://workspace/${MICROPHONE_WORKLET_ASSET}`;
export const WINDOW_SECURITY = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
});
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
export function trustedFrame(value: {
  senderId: number;
  ownerId: number;
  senderFrame: unknown;
  mainFrame: unknown;
  url: string;
  args: unknown[];
}): boolean {
  return (
    value.senderId === value.ownerId &&
    value.senderFrame != null &&
    value.senderFrame === value.mainFrame &&
    (value.url === WORKSPACE_URL ||
      value.url.startsWith(`${WORKSPACE_URL}#`))
  );
}
export function trustedCaller(value: Parameters<typeof trustedFrame>[0]): boolean {
  return trustedFrame(value) && value.args.length === 0;
}
export function assetPath(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "pet-app:" ||
      url.hostname !== "workspace" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    if (url.pathname === "/index.html") return "index.html";
    if (url.pathname === "/assets/app-icon.svg") return "assets/app-icon.svg";
    if (/^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname))
      return url.pathname.slice(1);
  } catch {
    /* 不向页面暴露解析输入。 */
  }
  return undefined;
}
