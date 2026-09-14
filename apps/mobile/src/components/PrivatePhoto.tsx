import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import type { PhotoMetadata } from "@p1/mobile-contracts";
import { useAuth } from "../auth/AuthProvider";
import { createPrivatePhotoAdapter } from "../data/privatePhotos";
import { colors, spacing } from "../theme/styles";
export function PrivatePhoto({ metadata }: { metadata: PhotoMetadata }) {
  const { profile } = useAuth(); const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!profile) return;
    const controller = new AbortController(); let release: () => void = () => undefined;
    void createPrivatePhotoAdapter().load(metadata, profile.userId, controller.signal)
      .then(result => { if (!controller.signal.aborted) { release = result.release; setUri(result.uri); } else result.release(); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); release(); setUri(null); };
  }, [metadata, profile]);
  return <View style={styles.card}>
    {uri ? <Image accessibilityLabel={metadata.caption || "Work-order photo"} source={{ uri }}
      cachePolicy="memory" contentFit="cover" style={styles.image} /> :
      <View style={styles.placeholder}><Text>{failed ? "Photo unavailable" : "Loading photo..."}</Text></View>}
    <Text style={styles.caption}>{metadata.caption || "No caption"}</Text>
    <Text style={styles.meta}>{metadata.uploaderName || "Approved uploader"}{metadata.createdAt ? ` - ${new Date(metadata.createdAt).toLocaleString()}` : ""}</Text>
  </View>;
}
const styles = StyleSheet.create({ card: { width: 240, gap: spacing.xs }, image: { width: 240, height: 180, borderRadius: 10 },
  placeholder: { width: 240, height: 180, borderRadius: 10, backgroundColor: colors.surfaceMuted,
    alignItems: "center", justifyContent: "center" }, caption: { color: colors.ink, fontWeight: "600" },
  meta: { color: colors.inkMuted, fontSize: 12 } });
