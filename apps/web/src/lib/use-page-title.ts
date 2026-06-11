import { useEffect } from "react";

const PRODUCT_TITLE = "Pageden";

export function pageTitle(...parts: Array<string | null | undefined>): string {
  const cleaned = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));

  if (cleaned.length === 0) return PRODUCT_TITLE;
  if (cleaned.length === 1) return `${cleaned[0]} - ${PRODUCT_TITLE}`;
  return cleaned.join(" - ");
}

export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title.trim() || PRODUCT_TITLE;

    return () => {
      document.title = PRODUCT_TITLE;
    };
  }, [title]);
}
