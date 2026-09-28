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
    ? spaceAbove >= maxHeight || spaceAbove >= spaceBelow
    : spaceBelow < maxHeight && spaceAbove > spaceBelow;
  // Size to the chosen side before positioning. Clamping a full-height panel
  // into the viewport could otherwise cover its own trigger/adjacent controls.
  const availableHeight = Math.max(0, openAbove ? spaceAbove : spaceBelow);
  const fittedHeight = Math.min(maxHeight, availableHeight);
  const requestedTop = openAbove
    ? trigger.top - gap - fittedHeight
    : trigger.bottom + gap;

  return {
    width,
    maxHeight: fittedHeight,
    left: clamp(trigger.left + (trigger.width - width) / 2, margin, maxLeft),
    top: clamp(requestedTop + offsetY, margin, viewportHeight - fittedHeight - margin),
    placement: openAbove ? "top" : "bottom",
  };
}
