import PlausibleProvider from 'next-plausible'
import type { AppProps } from 'next/app'
import 'nextra-theme-docs/style.css'

function MyApp({ Component, pageProps }: AppProps) {
  return (
    <PlausibleProvider domain="docs.dembrane.com">
      <Component {...pageProps} />
    </PlausibleProvider>
  )
}

export default MyApp
