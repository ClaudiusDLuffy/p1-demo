import type { ReactNode } from "react";
import type { PortalNavigationItem } from "../../lib/portalNavigationItems";

const FOCUSED_IDS = new Set(["simplified", "my_schedule", "billing"]);

/** Only groups already-authorized items. Never adds a page or grants access. */
export function FocusedPortalNavigation({ items, enabled, children }: {
  items: readonly PortalNavigationItem[]; enabled: boolean; children: (item: PortalNavigationItem) => ReactNode;
}) {
  if (!enabled) return <>{items.map(children)}</>;
  return <>
    {items.filter(item => FOCUSED_IDS.has(item.id)).map(children)}
    <details className="mt-3">
      <summary className="min-h-11 cursor-pointer content-center px-5 text-sm text-p1-subtle">More tools</summary>
      {items.filter(item => !FOCUSED_IDS.has(item.id)).map(children)}
    </details>
  </>;
}
