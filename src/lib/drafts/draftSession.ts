export const DRAFT_MAX_BYTES = 512 * 1024;
export const DRAFT_MAX_RECORDS = 16;
export const DRAFT_SWEEP_LIMIT = 256;
export type DraftKind = "staff-billing" | "quote-calculator";
export type DraftScope = { environment: "development" | "test" | "preview" | "production"; project: string };
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
export type DraftFailure = "unavailable" | "invalid" | "oversized" | "revoked" | "conflict" | "capacity";
export type DraftSaveResult = { status: "persisted"; revision: string; savedAt: string }
  | { status: DraftFailure };
export type DraftLease<T> = {
  read(): T | null;
  save(payload: T): DraftSaveResult;
  isPersisted(): boolean;
  discard(): boolean;
  close(): void;
};
type Entry = { key: string; epoch: string; active: boolean };
type Actor = { userId: string; epoch: string };
type Envelope = { version: 1; environment: string; project: string; ownerId: string; kind: DraftKind;
  entity: string; actorEpoch: string; documentEpoch: string; revision: string; savedAt: string; payload: unknown };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const bounded = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const parse = (raw: string | null, limit: number): unknown => {
  if (!raw || raw.length > limit || bytes(raw) > limit) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
};

/** Metadata and payload stay in injected storage. No browser access or logging. */
export function createDraftSession(options: DraftScope & { storage: DraftStorage; now?: () => number;
  random?: () => string; diagnostic?: (category: "draft_storage_failure" | "draft_purge_incomplete", count: number) => void }) {
  const { storage } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => crypto.randomUUID());
  const base = `p1:${encodeURIComponent(options.environment)}:${encodeURIComponent(options.project)}`;
  let actor: Actor | null = null;
  let lastRevokedUser: string | null = null;
  let generation = 0;
  const closed = new Set<() => void>();
  const diagnostic = (category: "draft_storage_failure" | "draft_purge_incomplete", count = 1) => {
    try { options.diagnostic?.(category, Math.min(count, DRAFT_SWEEP_LIMIT)); } catch { /* Diagnostics cannot affect logout. */ }
  };
  const indexKey = (userId: string) => `${base}:draft-index:${userId}`;
  const actorKey = (userId: string) => `${base}:draft-meta:${userId}`;
  const currentKey = `${base}:draft-current`;
  const sweepKey = `${base}:draft-sweep`;
  const owned = (key: string, userId: string) => key.startsWith(`${base}:draft:${userId}:staff-billing:`)
    || key.startsWith(`${base}:draft:${userId}:quote-calculator:`);
  const entries = (userId: string): Entry[] => {
    const value = parse(storage.getItem(indexKey(userId)), 16384);
    if (!object(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > DRAFT_MAX_RECORDS) return [];
    const result: Entry[] = [];
    for (const item of value.entries) {
      if (!object(item) || Object.keys(item).length !== 3 || !bounded(item.key, 1024) || !owned(item.key, userId)
        || !bounded(item.epoch, 100) || typeof item.active !== "boolean" || result.some(e => e.key === item.key)) return [];
      result.push({ key: item.key, epoch: item.epoch, active: item.active });
    }
    return result;
  };
  const writeEntries = (userId: string, values: Entry[]) => {
    const raw = JSON.stringify({ version: 1, entries: values });
    storage.setItem(indexKey(userId), raw);
    if (storage.getItem(indexKey(userId)) !== raw) throw new Error("Draft metadata unavailable");
  };
  const fence = () => { generation++; actor = null; for (const close of closed) close(); closed.clear(); };
  const epochCurrent = (expected: Actor) => {
    const value = parse(storage.getItem(actorKey(expected.userId)), 512);
    return object(value) && value.active === true && value.epoch === expected.epoch
      && storage.getItem(currentKey) === expected.userId;
  };
  const purge = (userId: string) => {
    let failures = 0;
    try {
      // Tombstone precedes removal. Old tabs cannot write or restore old data even if deletion fails.
      const raw = JSON.stringify({ active: false, epoch: random() });
      storage.setItem(actorKey(userId), raw);
      if (storage.getItem(actorKey(userId)) !== raw) failures++;
    } catch { failures++; }
    let registered: Entry[] = [];
    try { registered = entries(userId); } catch { failures++; }
    for (const entry of registered) {
      try { storage.removeItem(entry.key); if (storage.getItem(entry.key) !== null) failures++; } catch { failures++; }
    }
    if (!failures) { try { storage.removeItem(indexKey(userId)); } catch { failures++; } }
    if (failures) diagnostic("draft_purge_incomplete", failures);
    return failures === 0;
  };
  const sweep = (purgeUser?: string) => {
    // Legacy formats have no environment/project proof: never restore them.
    // Only known application draft prefixes are removed; Auth/preferences/other keys stay untouched.
    let failures = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const savedCursor = Number(storage.getItem(sweepKey) ?? "-1");
        const cursor = Number.isInteger(savedCursor) && savedCursor >= 0 ? Math.min(savedCursor, storage.length - 1) : storage.length - 1;
        const keys: string[] = [];
        const end = Math.max(-1, cursor - DRAFT_SWEEP_LIMIT);
        for (let index = cursor; index > end; index--) {
          const key = storage.key(index);
          if (!key) continue;
          if (key.startsWith("p1:staff-billing-draft:v1:") || key.startsWith("p1:quote-calculator:v1:")) { keys.push(key); continue; }
          if (!key.startsWith(`${base}:draft:`)) continue;
          const current = actor;
          if (purgeUser && owned(key, purgeUser)) { keys.push(key); continue; }
          if (!current || !owned(key, current.userId)) { keys.push(key); continue; }
          const record = entries(current.userId).find(entry => entry.key === key);
          const envelope = parse(storage.getItem(key), DRAFT_MAX_BYTES);
          if (!record?.active || !object(envelope) || envelope.version !== 1 || envelope.ownerId !== current.userId
            || envelope.environment !== options.environment || envelope.project !== options.project
            || envelope.actorEpoch !== current.epoch || envelope.documentEpoch !== record.epoch) keys.push(key);
        }
        for (const key of keys) { try { storage.removeItem(key); if (storage.getItem(key) !== null) failures++; } catch { failures++; } }
        storage.setItem(sweepKey, String(end));
        if (end < 0) break;
      } catch { failures++; break; }
    }
    if (failures) diagnostic("draft_purge_incomplete", failures);
  };
  return {
    generation: () => generation,
    hasDrafts() {
      try { return !!actor && epochCurrent(actor) && entries(actor.userId).some(entry => entry.active && storage.getItem(entry.key) !== null); }
      catch { return false; }
    },
    suspend() { fence(); },
    activate(userId: string, active: boolean, ticket = generation): boolean {
      if (ticket !== generation || !uuid(userId) || !bounded(options.project, 200)) return false;
      if (!active) { fence(); lastRevokedUser = userId; purge(userId); sweep(userId); return false; }
      try {
        if (actor?.userId === userId && epochCurrent(actor)) { sweep(); return true; }
        const previous = storage.getItem(currentKey);
        if (uuid(previous) && previous !== userId) purge(previous);
        const value = parse(storage.getItem(actorKey(userId)), 512);
        if (lastRevokedUser === userId || (object(value) && value.active === false)) { purge(userId); sweep(userId); }
        const epoch = lastRevokedUser !== userId && previous === userId && object(value) && value.active === true && bounded(value.epoch, 100) ? value.epoch : random();
        const raw = JSON.stringify({ active: true, epoch });
        storage.setItem(actorKey(userId), raw);
        storage.setItem(currentKey, userId);
        if (storage.getItem(actorKey(userId)) !== raw || storage.getItem(currentKey) !== userId) throw new Error("Draft metadata unavailable");
        actor = { userId, epoch }; if (lastRevokedUser === userId) lastRevokedUser = null; sweep(); return true;
      } catch { fence(); diagnostic("draft_storage_failure"); return false; }
    },
    revoke(userId?: string | null): boolean {
      const previous = userId ?? actor?.userId;
      fence();
      let result = true;
      if (uuid(previous)) { lastRevokedUser = previous; result = purge(previous); }
      else { try { const current = storage.getItem(currentKey); if (uuid(current)) { lastRevokedUser = current; result = purge(current); } } catch { result = false; } }
      sweep(uuid(previous) ? previous : undefined);
      return result;
    },
    storageChanged() {
      if (!actor) return;
      try { if (!epochCurrent(actor)) fence(); } catch { fence(); diagnostic("draft_storage_failure"); }
    },
    open<T>(kind: DraftKind, entity: string, validate: (payload: unknown) => T | null, maxAgeMs?: number): DraftLease<T> | null {
      if (!actor || closed.size >= DRAFT_MAX_RECORDS || !bounded(entity, 200)
        || (kind !== "staff-billing" && kind !== "quote-calculator")) return null;
      const expected = actor;
      const ticket = generation;
      const key = `${base}:draft:${expected.userId}:${kind}:${encodeURIComponent(entity)}`;
      let entry: Entry;
      let registered = false;
      try {
        if (!epochCurrent(expected)) return null;
        const values = entries(expected.userId).filter(item => item.active || storage.getItem(item.key) !== null);
        const existing = values.find(item => item.key === key);
        registered = existing?.active === true;
        entry = existing?.active ? existing : { key, active: true, epoch: random() };
      } catch { diagnostic("draft_storage_failure"); return null; }
      let live = true;
      let revision: string | null = null;
      let confirmed: string | null = null;
      let discardEpoch: string | null = null;
      const close = () => { live = false; confirmed = null; closed.delete(close); };
      closed.add(close);
      const valid = () => {
        if (!live || actor !== expected || generation !== ticket || !epochCurrent(expected)) return false;
        const current = entries(expected.userId).find(item => item.key === key);
        return registered ? current?.epoch === entry.epoch && current.active : !current?.active;
      };
      const envelope = (raw = storage.getItem(key)): Envelope | null => {
        const value = parse(raw, DRAFT_MAX_BYTES);
        if (!object(value) || Object.keys(value).sort().join() !== "actorEpoch,documentEpoch,entity,environment,kind,ownerId,payload,project,revision,savedAt,version"
          || value.version !== 1 || value.environment !== options.environment || value.project !== options.project
          || value.ownerId !== expected.userId || value.kind !== kind || value.entity !== entity || value.actorEpoch !== expected.epoch
          || value.documentEpoch !== entry.epoch || !bounded(value.revision, 100) || typeof value.savedAt !== "string") return null;
        const at = Date.parse(value.savedAt);
        if (!Number.isFinite(at) || at > now() || (maxAgeMs !== undefined && now() - at > maxAgeMs)) return null;
        return value as Envelope;
      };
      return {
        read() {
          try {
            if (!valid()) return null;
            const raw = storage.getItem(key);
            const value = envelope(raw);
            const payload = value ? validate(value.payload) : null;
            if (!value || payload === null) {
              if (raw && valid() && storage.getItem(key) === raw) {
                storage.removeItem(key); if (storage.getItem(key) !== null) diagnostic("draft_purge_incomplete");
              }
              return null;
            }
            if (!valid() || storage.getItem(key) !== raw) { confirmed = null; return null; }
            revision = value.revision; confirmed = raw; return payload;
          } catch { diagnostic("draft_storage_failure"); return null; }
        },
        save(payload) {
          try {
            confirmed = null;
            if (!valid()) return { status: "revoked" };
            const parsed = validate(payload);
            if (parsed === null) return { status: "invalid" };
            const current = envelope();
            if (current && current.revision !== revision) return { status: "conflict" };
            const next: Envelope = { version: 1, environment: options.environment, project: options.project, ownerId: expected.userId,
              kind, entity, actorEpoch: expected.epoch, documentEpoch: entry.epoch, revision: random(), savedAt: new Date(now()).toISOString(), payload: parsed };
            const raw = JSON.stringify(next);
            if (bytes(raw) > DRAFT_MAX_BYTES) return { status: "oversized" };
            if (!valid()) return { status: "revoked" };
            if (!registered) {
              const values = entries(expected.userId).filter(item => item.active || storage.getItem(item.key) !== null);
              if (values.filter(item => item.key !== key).length >= DRAFT_MAX_RECORDS) return { status: "capacity" };
              writeEntries(expected.userId, [...values.filter(item => item.key !== key), entry]);
              registered = true;
              if (!valid()) return { status: "revoked" };
            }
            // Best-effort conflict detection; localStorage does not provide atomic cross-tab CAS.
            const latest = envelope();
            if (latest && latest.revision !== revision) return { status: "conflict" };
            storage.setItem(key, raw);
            if (!valid()) {
              // A logout may interleave with setItem in another tab. Remove only this exact stale write, never a newer actor's payload.
              try { if (storage.getItem(key) === raw) { storage.removeItem(key); if (storage.getItem(key) === raw) diagnostic("draft_purge_incomplete"); } }
              catch { diagnostic("draft_purge_incomplete"); }
              return { status: "revoked" };
            }
            if (storage.getItem(key) !== raw) return { status: "unavailable" };
            revision = next.revision; confirmed = raw;
            return { status: "persisted", revision: next.revision, savedAt: next.savedAt };
          } catch { diagnostic("draft_storage_failure"); return { status: "unavailable" }; }
        },
        isPersisted() { try { return !!confirmed && valid() && storage.getItem(key) === confirmed; } catch { return false; } },
        discard() {
          let permitted = false;
          try { permitted = valid() || (!!discardEpoch && actor === expected && generation === ticket && epochCurrent(expected)
            && entries(expected.userId).some(item => item.key === key && item.epoch === discardEpoch && !item.active)); }
          catch { /* A revoked lease must never remove a new session's draft. */ }
          close();
          if (!permitted) return false;
          try {
            if (!registered && storage.getItem(key) === null) return true;
            const values = entries(expected.userId);
            const nextEpoch = discardEpoch ?? random();
            discardEpoch = nextEpoch;
            writeEntries(expected.userId, values.map(item => item.key === key ? { ...item, active: false, epoch: nextEpoch } : item));
            storage.removeItem(key);
            return storage.getItem(key) === null;
          } catch { diagnostic("draft_purge_incomplete"); return false; }
        },
        close,
      };
    },
  };
}

export type DraftSession = ReturnType<typeof createDraftSession>;
