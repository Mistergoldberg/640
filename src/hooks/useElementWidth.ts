import { useEffect, useRef, useState } from "react";
import { registerArchiveObserver } from "../debug/archiveDiagnostics";

export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const updateWidth = () => {
      setWidth(element.clientWidth);
    };

    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      const unregister = registerArchiveObserver("element-width-window-resize");
      window.addEventListener("resize", updateWidth);
      return () => {
        window.removeEventListener("resize", updateWidth);
        unregister();
      };
    }

    const observer = new ResizeObserver(updateWidth);
    const unregister = registerArchiveObserver("element-width-resize-observer");
    observer.observe(element);
    return () => {
      observer.disconnect();
      unregister();
    };
  }, []);

  return { ref, width };
}
