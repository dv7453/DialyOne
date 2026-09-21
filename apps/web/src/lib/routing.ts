export type AppView = "chat" | "access";

export type AppLocation = {
  view: AppView;
  loginToken: string | null;
  onLoginPath: boolean;
};

export function readAppLocation(): AppLocation {
  const url = new URL(window.location.href);
  const loginToken = url.searchParams.get("token");
  const onLoginPath = url.pathname === "/login" || Boolean(loginToken);
  if (url.pathname === "/access") {
    return { view: "access", loginToken: null, onLoginPath: false };
  }
  return { view: "chat", loginToken, onLoginPath };
}

export function replaceAppPath(path: string): void {
  const next = path.startsWith("/") ? path : `/${path}`;
  if (`${window.location.pathname}${window.location.search}` === next) return;
  window.history.replaceState(null, "", next);
}

export function pushAppPath(path: string): void {
  const next = path.startsWith("/") ? path : `/${path}`;
  if (`${window.location.pathname}${window.location.search}` === next) return;
  window.history.pushState(null, "", next);
}
