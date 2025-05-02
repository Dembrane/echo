const withNextra = require('nextra')({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.tsx',
})

module.exports = withNextra({
  i18n: {
    locales: ["en-US", "nl-NL"],
    defaultLocale: "en-US",
  },
  webpack: (config, { isServer }) => {
    
    config.module.rules.push({
      test: /\.mmd$/,
      type: 'asset/source',
    })
    
    return config
  },

})

