// Contains identities and flags only, never form values. Used solely to show
// one explicit logout warning. Forced identity loss never asks this registry.
const MAX_FORMS = 128;
const forms = new Set<symbol>();
let overflow = 0;

export function registerDirtySensitiveForm(): () => void {
  const id = Symbol("dirty-form");
  const overflowed = forms.size >= MAX_FORMS;
  if (overflowed) overflow += 1;
  else forms.add(id);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (overflowed) overflow = Math.max(0, overflow - 1);
    else forms.delete(id);
  };
}

export function hasDirtySensitiveForms(): boolean {
  return forms.size > 0 || overflow > 0;
}

export function dirtyFormRegistrySize(): number { return forms.size; }
