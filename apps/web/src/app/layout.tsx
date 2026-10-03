import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "digital memory",
  description: "digital memory",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" className={GeistSans.variable + " " + GeistMono.variable} suppressHydrationWarning><body><Providers>{children}</Providers></body></html>;
}
