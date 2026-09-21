import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "動画一次情報記事制作アプリ", description: "動画の一次情報からSEO記事の下書きを制作するアプリ" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ja"><body>{children}</body></html>; }
