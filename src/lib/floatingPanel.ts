export type FloatingPanelPlacement = "bottom" | "top" | "right" | "left";

type TriggerRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
};

type FloatingPanelOptions = {
  trigger: TriggerRect;
  panelWidth: number;
  panelHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  preferredPlacement?: "bottom" | "top" | "right";
  margin?: number;
  gap?: number;
  offsetY?: number;
};

export type FloatingPanelPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: FloatingPanelPlacement;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export function getFloatingPanelPosition({
  trigger,
  panelWidth,
  panelHeight,
  viewportWidth,
  viewportHeight,
  preferredPlacement = "bottom",
  margin = 16,
  gap = 8,
  offsetY = 0,
}: FloatingPanelOptions): FloatingPanelPosition {
  const width = Math.min(panelWidth, Math.max(0, viewportWidth - margin * 2));
  const maxHeight = Math.min(panelHeight, Math.max(0, viewportHeight - margin * 2));
  const maxLeft = viewportWidth - width - margin;
  const maxTop = viewportHeight - maxHeight - margin;

  if (preferredPlacement === "right") {
    const rightLeft = trigger.right + gap;
    const leftLeft = trigger.left - width - gap;
    const fitsRight = rightLeft + width <= viewportWidth - margin;

    return {
      width,
      maxHeight,
      left: clamp(fitsRight ? rightLeft : leftLeft, margin, maxLeft),
      top: clamp(trigger.top + offsetY, margin, maxTop),
      placement: fitsRight ? "right" : "left",
    };
  }

  const spaceBelow = viewportHeight - margin - trigger.bottom - gap;
  const spaceAbove = trigger.top - gap - margin;
  const openAbove = preferredPlacement === "top"
    || (spaceBelow < maxHeight && spaceAbove > spaceBelow);
  const requestedTop = openAbove
    ? trigger.top - gap - maxHeight
    : trigger.bottom + gap;

  return {
    width,
    maxHeight,
    left: clamp(trigger.left + (trigger.width - width) / 2, margin, maxLeft),
    top: clamp(requestedTop + offsetY, margin, maxTop),
    placement: openAbove ? "top" : "bottom",
  };
}
