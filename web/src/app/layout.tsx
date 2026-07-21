import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Y - The AI Moment for Education",
  description:
    "Y is a learning companion that understands your confusion and draws your understanding. Master complex topics through fluid, visual conversations.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {/* Material Symbols is an icon font, not a page typography font. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&display=swap"
        />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
