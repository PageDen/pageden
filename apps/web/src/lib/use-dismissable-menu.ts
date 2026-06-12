import { useEffect, useRef } from "react";

/**
 * Dismissal behavior for dropdown menus built on native <details>/<summary>.
 * Native <details> only toggles via its own <summary>, so without this the
 * menu stays open until the trigger is clicked again. Attach the returned ref
 * to the <details> element; the menu then also closes on outside click/tap
 * and on Escape.
 */
export function useDismissableMenu() {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const el = ref.current;
      if (el?.open && event.target instanceof Node && !el.contains(event.target)) {
        el.removeAttribute("open");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const el = ref.current;
      if (el?.open && event.key === "Escape") el.removeAttribute("open");
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return ref;
}
