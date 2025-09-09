import React from 'react'
import { DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: <span> Dembrane Docs: ECHO</span>,
  docsRepositoryBase: "https://github.com/Dembrane/pilot/tree/main/docs",
  banner: {
    key: 'in-progress',
    content: "🚧 Dembrane Docs is under construction - Things will change"
  },
  footer: {
    content: "Dembrane Docs",
  },
  i18n: [
    { locale: "en-US", name: "English" },
    { locale: "nl-NL", name: "Nederlands" },
  ],
  
}

export default config
