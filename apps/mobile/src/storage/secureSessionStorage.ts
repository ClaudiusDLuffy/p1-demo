import * as SecureStore from "expo-secure-store";

export type SecureKeyValue = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};
const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 64;
const safeKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "_");
const manifestKey = (key: string) => `p1.auth.${safeKey(key)}.manifest`;
const chunkKey = (key: string, generation: string, index: number) =>
  `p1.auth.${safeKey(key)}.${generation}.${index}`;
type Manifest = { version: 1; generation: string; count: number };

function parseManifest(value: string | null): Manifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<Manifest>;
    return parsed.version === 1 && typeof parsed.generation === "string"
      && Number.isInteger(parsed.count) && Number(parsed.count) >= 0 && Number(parsed.count) <= MAX_CHUNKS
      ? { version: 1, generation: parsed.generation, count: Number(parsed.count) } : null;
  } catch { return null; }
}
async function removeChunks(store: SecureKeyValue, key: string, manifest: Manifest | null): Promise<void> {
  if (!manifest) return;
  await Promise.all(Array.from({ length: manifest.count }, (_, index) =>
    store.deleteItemAsync(chunkKey(key, manifest.generation, index))));
}

export function createChunkedSecureStorage(store: SecureKeyValue = SecureStore) {
  return {
    async getItem(key: string): Promise<string | null> {
      const manifest = parseManifest(await store.getItemAsync(manifestKey(key)));
      if (!manifest) return null;
      const chunks = await Promise.all(Array.from({ length: manifest.count }, (_, index) =>
        store.getItemAsync(chunkKey(key, manifest.generation, index))));
      if (chunks.some(value => value === null)) {
        await removeChunks(store, key, manifest);
        await store.deleteItemAsync(manifestKey(key));
        return null;
      }
      return chunks.join("");
    },
    async setItem(key: string, value: string): Promise<void> {
      const prior = parseManifest(await store.getItemAsync(manifestKey(key)));
      const count = Math.ceil(value.length / CHUNK_SIZE);
      if (count > MAX_CHUNKS) throw new Error("Encrypted session exceeds the supported size.");
      const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const next: Manifest = { version: 1, generation, count };
      try {
        for (let index = 0; index < count; index += 1) {
          await store.setItemAsync(chunkKey(key, generation, index), value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
        }
        await store.setItemAsync(manifestKey(key), JSON.stringify(next));
      } catch (error) {
        await removeChunks(store, key, next);
        throw error;
      }
      await removeChunks(store, key, prior);
    },
    async removeItem(key: string): Promise<void> {
      const manifest = parseManifest(await store.getItemAsync(manifestKey(key)));
      await store.deleteItemAsync(manifestKey(key));
      await removeChunks(store, key, manifest);
    },
  };
}
