import { useEffect, useState } from "react";
import { isPhoneLandscape } from "@shared/phone-landscape";

function readPhoneLandscape(): boolean {
  if (typeof window === "undefined") return false;
  return isPhoneLandscape({
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
  });
}

/** Whether this is a phone held in landscape — see `src/shared/phone-landscape.ts`.
 *  Re-read on resize (which rotation fires) and on `orientationchange`, for
 *  the browsers that fire that one first. */
export function usePhoneLandscape(): boolean {
  const [landscape, setLandscape] = useState(readPhoneLandscape);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setLandscape(readPhoneLandscape());
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    update();
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return landscape;
}
