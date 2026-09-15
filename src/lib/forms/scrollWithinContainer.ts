export type ScrollContainerLike = Pick<HTMLElement,
  "clientHeight" | "clientTop" | "getBoundingClientRect" | "scrollHeight" | "scrollTop">;
export type ScrollTargetLike = Pick<HTMLElement, "getBoundingClientRect">;

/**
 * Reveal a target by moving only its owning scroll container. Unlike
 * Element.scrollIntoView(), this never asks the browser to scroll the page or
 * any modal ancestors.
 */
export function scrollWithinContainer(
  container: ScrollContainerLike | null | undefined,
  target: ScrollTargetLike | null | undefined,
): void {
  if (!container || !target || container.clientHeight <= 0) return;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const visibleTop = containerRect.top + container.clientTop;
  const visibleBottom = visibleTop + container.clientHeight;
  let next = container.scrollTop;

  if (targetRect.top < visibleTop) {
    next += targetRect.top - visibleTop;
  } else if (targetRect.bottom > visibleBottom) {
    next += targetRect.bottom - visibleBottom;
  } else {
    return;
  }

  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  container.scrollTop = Math.min(maximum, Math.max(0, next));
}
