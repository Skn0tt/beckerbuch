import { useEffect, useRef } from "react";

/**
 * Calls `close` once when `isLoading` transitions from true → false,
 * i.e. when an in-flight action completes.
 */
export function useCloseOnIdle(isLoading: boolean, close: () => void) {
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (isLoading) {
      wasLoadingRef.current = true;
    } else if (wasLoadingRef.current) {
      wasLoadingRef.current = false;
      close();
    }
  }, [isLoading, close]);
}
