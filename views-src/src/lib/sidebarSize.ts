import { useLayoutEffect, useRef, useState, type RefObject } from "react";

const DEFAULT = 300;
const MIN = 220;
const MAX = 520;
const CHROME = 46 + 4; // activity rail and splitter
const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)));

export function sidebarBounds(bodyWidth: number) {
  if (!bodyWidth) return { min: MIN, max: MAX };
  const available = Math.max(0, bodyWidth - CHROME);
  // Reserve content space on narrow panels without changing the saved width.
  const max = Math.max(0, Math.min(MAX, available - Math.min(280, Math.ceil(available * 0.56))));
  return { min: Math.min(MIN, max), max };
}

export function useSidebarSize(body: RefObject<HTMLDivElement>, widthPreference: number | null | undefined,
  legacyRatio: number, persist: (width: number) => void) {
  const [bodyWidth, setBodyWidth] = useState(0);
  const [dragSize, setDragSize] = useState<number | null>(null);
  const drag = useRef<{ id: number; x: number; initial: number } | null>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setBodyWidth(element.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [body]);

  const { min, max } = sidebarBounds(bodyWidth);
  const preferred = widthPreference ?? (legacyRatio === 0.32 || !Number.isFinite(legacyRatio) ? DEFAULT : clamp(legacyRatio * 940, MIN, MAX));
  const width = clamp(dragSize ?? preferred, min, max);
  const save = (value: number) => persist(clamp(value, MIN, MAX));
  const abort = () => { drag.current = null; setDragSize(null); };

  return {
    width, dragging: dragSize !== null,
    splitter: {
      tabIndex: 0, "aria-valuemin": min, "aria-valuemax": max, "aria-valuenow": width,
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (!event.isPrimary || event.button !== 0 || min === max) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, initial: width };
        setDragSize(width);
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        const start = drag.current;
        if (start?.id === event.pointerId) setDragSize(clamp(start.initial + event.clientX - start.x, min, max));
      },
      onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
        const start = drag.current;
        if (start?.id !== event.pointerId) return;
        const next = clamp(start.initial + event.clientX - start.x, min, max);
        if (next !== start.initial) save(next);
        abort();
      },
      onLostPointerCapture: abort,
      onPointerCancel: abort,
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
        if (!delta && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const next = event.key === "Home" ? min : event.key === "End" ? max : clamp(width + delta, min, max);
        if (next !== width) save(next);
      },
    },
  };
}
