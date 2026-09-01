import type { ReactNode } from "react";

export const metadata = {
  title: "Planeon Harness Control Plane",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
