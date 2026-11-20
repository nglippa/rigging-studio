import type { Metadata } from "next";
import "./globals.css";
import "./studio-ui/step-shell.css";

export const metadata: Metadata = {
  title: "Rig Studio",
  description: "Modular 2D skeletal animation runtime foundation.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
