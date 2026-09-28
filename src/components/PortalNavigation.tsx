import type { PortalNavigationItem } from "../lib/portalNavigationItems";
import { BetaBadge } from "./ui/BetaBadge";
import { Ico } from "./ui/Ico";

type PortalNavigationProps = {
  items: readonly PortalNavigationItem[];
  selectedPage: string;
  onNavigate: (page: string) => void;
};

/** Page selection changes the highlight, never the authorized menu or its order. */
export function PortalNavigation({ items, selectedPage, onNavigate }: PortalNavigationProps) {
  return (
    <nav aria-label="Portal pages" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-3 py-3.5">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          aria-label={item.label}
          aria-current={selectedPage === item.id ? "page" : undefined}
          onClick={() => onNavigate(item.id)}
          className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-[13px] text-p1-subtle transition-colors hover:bg-p1-bg/[0.06] hover:text-p1-bg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-p1-accent aria-[current=page]:bg-p1-bg/[0.08] aria-[current=page]:font-semibold aria-[current=page]:text-p1-bg"
        >
          <span aria-hidden="true" className={`shrink-0 ${selectedPage === item.id ? "text-p1-accent" : ""}`}>
            <Ico d={item.icon} size={16} />
          </span>
          <span className="min-w-0 flex-1 break-words">{item.label}</span>
          {item.beta && <BetaBadge />}
          {item.badge != null && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold text-white ${item.id === "capital" ? "bg-p1-violet" : "bg-p1-accent"}`}>
              {item.badge}
            </span>
          )}
          {item.attentionBadge != null && item.attentionBadge > 0 && (
            <span
              title={`${item.attentionBadge} update${item.attentionBadge === 1 ? "" : "s"} need your attention`}
              className="min-w-5 shrink-0 rounded-full bg-p1-success px-1.5 py-0.5 text-center text-[10px] font-extrabold text-white"
            >
              {item.attentionBadge}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
