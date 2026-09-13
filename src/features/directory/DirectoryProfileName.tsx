"use client";
import { useDirectorySelection } from "./queries";

// A rendered historical row requests its exact identity; it never enumerates a
// directory or infers a portal login from a stored display-name snapshot.
export function DirectoryProfileName({ id, fallback = "Assigned contractor", company = false }: {
  id?: string | null; fallback?: string; company?: boolean;
}) {
  const { data } = useDirectorySelection("profile_labels", id);
  return <>{(company ? data?.company || data?.name : data?.name) || fallback}</>;
}
