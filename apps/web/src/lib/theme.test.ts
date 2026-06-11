import { describe, expect, it } from "vitest";
import { autoThemeForLocalTime } from "./theme";

describe("autoThemeForLocalTime", () => {
  it("uses dark mode overnight in the user's local time", () => {
    expect(autoThemeForLocalTime(new Date(2026, 5, 9, 0, 0))).toBe("dark");
    expect(autoThemeForLocalTime(new Date(2026, 5, 9, 5, 59))).toBe("dark");
    expect(autoThemeForLocalTime(new Date(2026, 5, 9, 18, 0))).toBe("dark");
    expect(autoThemeForLocalTime(new Date(2026, 5, 9, 23, 59))).toBe("dark");
  });

  it("uses light mode during daytime in the user's local time", () => {
    expect(autoThemeForLocalTime(new Date(2026, 5, 9, 6, 0))).toBe("light");
    expect(autoThemeForLocalTime(new Date(2026, 5, 9, 12, 0))).toBe("light");
    expect(autoThemeForLocalTime(new Date(2026, 5, 9, 17, 59))).toBe("light");
  });
});
