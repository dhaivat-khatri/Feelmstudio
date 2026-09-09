import { StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LandingPage } from './LandingPage.tsx'
import { SectionPage } from './SectionPage.tsx'
import { About } from '@/sections/About'
import { Services } from '@/sections/Services'
import { Showcase } from '@/sections/Showcase'
import { Pricing } from '@/sections/Pricing'
import { Contact } from '@/sections/Contact'
import { Toaster } from '@/components/ui/sonner'

document.documentElement.classList.add('dark')

// Flat, path-based routing — 5 static pages with no nesting or params, so a
// lookup table covers it without pulling in a router dependency.
const PAGES: Record<string, ComponentType> = {
  '/about': About,
  '/services': Services,
  '/portfolio': Showcase,
  '/pricing': Pricing,
  '/contact': Contact,
}

const path = window.location.pathname
const Section = PAGES[path]

const page = path.startsWith('/studio') ? (
  <App />
) : Section ? (
  <SectionPage Section={Section} />
) : (
  <LandingPage />
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page}
    <Toaster richColors position="top-right" />
  </StrictMode>,
)
