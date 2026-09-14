import { Directory, File, Paths } from "expo-file-system";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { MobileContractError, type PhotoMetadata } from "@p1/mobile-contracts";
import { getMobileEnvironment } from "./environment";
import { getNativeSupabase } from "../auth/supabase";

const directory = new Directory(Paths.cache, "p1-private-photos");
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];
const acquire = async () => {
  if (active < MAX_CONCURRENT) { active += 1; return; }
  await new Promise<void>(resolve => waiting.push(resolve));
  active += 1;
};
const release = () => { active -= 1; waiting.shift()?.(); };
const encodedPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const extension = (path: string) => {
  const match = /\.([a-z0-9]{2,5})$/i.exec(path);
  return match?.[1]?.toLowerCase() ?? "img";
};
export async function purgePhotoFiles(): Promise<void> {
  try { if (directory.exists) directory.delete(); } catch { /* cache cleanup is best effort */ }
}
export function createPrivatePhotoAdapter(client: SupabaseClient = getNativeSupabase()) {
  return {
    async load(metadata: PhotoMetadata, userId: string, signal?: AbortSignal): Promise<{ uri: string; release(): void }> {
      if (!metadata.path.startsWith(`wo/${metadata.workOrderId}/`)) throw new MobileContractError("invalid_response");
      await acquire();
      let target: File | null = null;
      try {
        signal?.throwIfAborted();
        const sessionResult = await client.auth.getSession();
        const session: Session | null = sessionResult.data.session;
        if (!session || session.user.id !== userId) throw new MobileContractError("auth_required", "Please sign in again.");
        if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
        target = new File(directory, `${userId}-${metadata.id}.${extension(metadata.path)}`);
        const env = getMobileEnvironment();
        const url = `${env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/authenticated/photos/${encodedPath(metadata.path)}`;
        const file = await File.downloadFileAsync(url, target, {
          headers: { apikey: env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${session.access_token}` },
          idempotent: true, ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        return { uri: file.uri, release: () => { try { if (file.exists) file.delete(); } catch { /* best effort */ } } };
      } catch (error) {
        try { if (target?.exists) target.delete(); } catch { /* best effort */ }
        throw error;
      } finally { release(); }
    },
  };
}
