import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'TTS Studio – Chuyển văn bản thành giọng nói miễn phí',
  description:
    'Chuyển văn bản thành giọng nói tự nhiên bằng Microsoft Edge TTS: miễn phí, không giới hạn độ dài, phát trực tiếp, phụ đề karaoke, tải MP3/SRT/VTT.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1120' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
