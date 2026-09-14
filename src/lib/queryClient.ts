import { QueryClient } from "@tanstack/react-query";
import { mutationRetry, queryRetry, queryRetryDelay } from "./errors/retryPolicy";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      retry: queryRetry,
      retryDelay: queryRetryDelay,
      refetchOnWindowFocus: false,
      // The single portal foreground owner coalesces visibility/online/focus.
      refetchOnReconnect: false,
    },
    mutations: { retry: mutationRetry },
  },
});
