import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "@/config";

export function useConversationsHealthStream(conversationIds?: string[]) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const [countEventReceived, setCountEventReceived] = useState<number>(0);
  const [sseConnectionHealthy, setSseConnectionHealthy] = useState<boolean>(true);
  const [lastPingTime, setLastPingTime] = useState<Date | null>(null);

  useEffect(() => {
    if (conversationIds && conversationIds.length > 0) {
      const conversationIdsParam = conversationIds.join(',');
      const eventSource = new EventSource(
        `${API_BASE_URL}/conversations/health/stream?conversation_ids=${conversationIdsParam}`
      );
      eventSourceRef.current = eventSource;

      eventSource.addEventListener("ping", (ev: Event) => {
        if (ev instanceof MessageEvent) {
          const now = new Date();
          setLastPingTime(now);
          setSseConnectionHealthy(true);
          setCountEventReceived(prev => prev + 1);
        }
      });

      eventSource.addEventListener("error", () => {
        console.error("Health stream connection error");
        setSseConnectionHealthy(false);
      });

      return () => {
        eventSource.close();
        setSseConnectionHealthy(false);
      };
    }
  }, [conversationIds]);

  // Check ping freshness
  useEffect(() => {
    const interval = setInterval(() => {
      if (lastPingTime) {
        const now = new Date();
        const timeSinceLastPing = now.getTime() - lastPingTime.getTime();
        const oneMinuteInMs = 60 * 1000;

        if (timeSinceLastPing > oneMinuteInMs) {
          console.warn("No ping in last minute - marking unhealthy");
          setSseConnectionHealthy(false);
        }
      } else {
        setSseConnectionHealthy(false);
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [lastPingTime]);

  return {
    eventSourceRef,
    countEventReceived,
    sseConnectionHealthy,
    lastPingTime,
  };
}
