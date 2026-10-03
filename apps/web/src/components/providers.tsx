"use client";

import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: React.ReactNode }) {
  return <ThemeProvider attribute="class" defaultTheme="dark" storageKey="digital-memory-theme" enableSystem={false} disableTransitionOnChange><TooltipProvider>{children}</TooltipProvider></ThemeProvider>;
}
