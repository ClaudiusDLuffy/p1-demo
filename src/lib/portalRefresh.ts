export const PORTAL_AUTO_REFRESH_MS = 3 * 60 * 1000;

export function shouldRefreshPortal(input: {
  authenticated: boolean;
  visible: boolean;
  online: boolean;
  busy: boolean;
}): boolean {
  return input.authenticated
    && input.visible
    && input.online
    && !input.busy;
}
