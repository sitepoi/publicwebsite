import type { Metadata } from 'next'
import { TenantRegisterForm } from './register-form'

export const metadata: Metadata = {
  title: 'Create your website',
  description: 'Create a tenant and a website on this platform.',
  robots: { index: false, follow: false },
}

export default function TenantRegisterPage() {
  return <TenantRegisterForm />
}
