import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type ThemeMode = "light" | "dark" | "auto";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
}

const storageKey = "pageden.theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function autoThemeForLocalTime(date = new Date()): "light" | "dark" {
  const hour = date.getHours();
  return hour >= 18 || hour < 6 ? "dark" : "light";
}

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "auto";
  const value = window.localStorage.getItem(storageKey);
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "auto" ? autoThemeForLocalTime() : mode;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolveTheme(readStoredMode()));

  useEffect(() => {
    window.localStorage.setItem(storageKey, mode);

    function refresh() {
      setResolved(resolveTheme(mode));
    }

    refresh();
    if (mode !== "auto") return;

    const interval = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(interval);
  }, [mode]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved,
      setMode: setModeState,
    }),
    [mode, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
