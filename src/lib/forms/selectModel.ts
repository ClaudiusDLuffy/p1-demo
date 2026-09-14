export type SelectOption = { value: string; label: string; sub: string; search: string; disabled: boolean; index: number };
export const SELECT_TYPEAHEAD_MS = 700;
export const MAX_SELECT_SEARCH = 200;
export function nextEnabledOption(options: readonly SelectOption[], current: number, direction: "next" | "previous" | "first" | "last"): number {
  const enabled = options.filter(option => !option.disabled);
  if (!enabled.length) return -1;
  if (direction === "first") return enabled[0].index;
  if (direction === "last") return enabled[enabled.length - 1].index;
  const position = enabled.findIndex(option => option.index === current);
  if (position < 0) return direction === "previous" ? enabled[enabled.length - 1].index : enabled[0].index;
  return enabled[(position + (direction === "next" ? 1 : enabled.length - 1) + enabled.length) % enabled.length].index;
}
export function typeaheadOption(options: readonly SelectOption[], current: number, text: string): number {
  const raw = text.slice(0, MAX_SELECT_SEARCH).toLocaleLowerCase();
  const normalized = raw.length > 1 && [...raw].every(character => character === raw[0]) ? raw[0] : raw;
  const start = options.findIndex(option => option.index === current);
  for (let offset = 1; offset <= options.length; offset++) {
    const option = options[(Math.max(start, -1) + offset) % options.length];
    if (option && !option.disabled && option.label.toLocaleLowerCase().startsWith(normalized)) return option.index;
  }
  return current;
}
