import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GeneralWebsite NEXT-GEN',
  description:
    'Serves public websites entirely from the Uniconhub object-management system (pages are objects).',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-full flex flex-col antialiased">{children}</body>
    </html>
  )
}
