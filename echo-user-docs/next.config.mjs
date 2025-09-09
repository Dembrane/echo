
import nextra from 'nextra'

const withNextra = nextra({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
})

export default withNextra({
  i18n: {
    locales: ["en-US", "nl-NL"],
    defaultLocale: "en-US",
  },
})

