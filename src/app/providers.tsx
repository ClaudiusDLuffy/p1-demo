"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../lib/queryClient";
import DeploymentVersionGuard from "../components/DeploymentVersionGuard";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <DeploymentVersionGuard>{children}</DeploymentVersionGuard>
    </QueryClientProvider>
  );
}
