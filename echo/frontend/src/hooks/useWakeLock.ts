import { useEffect, useRef } from "react";

export const useWakeLock = ({ obtainWakeLockOnMount = true }) => {
  const wakeLock = useRef<null | WakeLockSentinel>(null);

  const releaseWakeLock = () => {
    if (wakeLock.current) {
      wakeLock.current.release();
    } else {
      //   console.log("no active wakelock to release");
    }
  };

  const obtainWakeLock = async () => {
    if ("wakeLock" in navigator) {
      try {
        const wakelock = await navigator.wakeLock.request("screen");
        releaseWakeLock();
        if (wakelock) {
          // console.log("wakelock obtained")
          wakeLock.current = wakelock;
        }
      } catch (err) {
        // console.error("obtaining wakelock failed:", err);
      }
    } else {
      // console.log("wakeLock not supported");
    }
  };

  useEffect(() => {
    if (obtainWakeLockOnMount) {
      obtainWakeLock();
    }
    // Re-acquire wake lock when tab becomes visible again
    const handleVisibilityChange = () => {
      if (
        !document.hidden &&
        (!wakeLock.current || wakeLock.current.released)
      ) {
        obtainWakeLock();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      releaseWakeLock();
    };
  }, [wakeLock]);

  return {
    wakeLock,
    obtainWakeLock,
    releaseWakeLock,
  };
};
