// hooks.ts — shared React hooks for the TUI.
import { useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TermSize {
  columns: number;
  rows: number;
}

// Live terminal dimensions — updates on resize so panels can budget their
// truncation widths from the real width instead of hardcoded char counts
// (v1 hardcoded trunc(…, 18-44) and wasted half of any wide terminal).
export function useTermSize(): TermSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TermSize>({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () =>
      setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}
