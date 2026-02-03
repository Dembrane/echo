const { defineConfig } = require("cypress");
const fs = require('fs');
const path = require('path');

module.exports = defineConfig({
    experimentalWebKitSupport: true,
    e2e: {
        setupNodeEvents(on, config) {
            on('task', {
                log(message) {
                    console.log(message);
                    return null;
                },
                deleteFile(filePath) {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        return true;
                    }
                    return null;
                },
                findFile({ dir, ext }) {
                    if (!fs.existsSync(dir)) return null;
                    const files = fs.readdirSync(dir);
                    const foundFiles = files.filter(file => file.endsWith(ext));
                    if (foundFiles.length === 0) return null;

                    // Return the most recently modified file
                    const recentFile = foundFiles.map(file => {
                        const filePath = path.join(dir, file);
                        return { file, mtime: fs.statSync(filePath).mtime };
                    }).sort((a, b) => b.mtime - a.mtime)[0].file;

                    return path.join(dir, recentFile);
                },
            });

            // Add browser launch arguments for fake media devices (cross-browser support)
            on('before:browser:launch', (browser = {}, launchOptions) => {
                // Chromium-based browsers (Chrome, Edge, Electron)
                if (browser.family === 'chromium' || browser.name === 'chrome') {
                    // Use fake media devices for microphone/camera testing
                    launchOptions.args.push('--use-fake-device-for-media-stream');
                    launchOptions.args.push('--use-fake-ui-for-media-stream');
                    // Auto-accept permission prompts
                    launchOptions.args.push('--disable-features=WebRtcHideLocalIpsWithMdns');

                    // Use a specific file for fake audio capture (fake microphone input)
                    // Note: This requires a .wav file.
                    launchOptions.args.push('--use-file-for-fake-audio-capture=c:/Users/charu/OneDrive/Desktop/echo/echo/cypress/fixtures/test-audio.wav');

                    // Grant clipboard permissions
                    // Ensure preferences object exists
                    if (!launchOptions.preferences) {
                        launchOptions.preferences = {};
                    }

                    launchOptions.preferences.default = {
                        profile: {
                            content_settings: {
                                exceptions: {
                                    clipboard: {
                                        '*': { setting: 1 }
                                    }
                                }
                            }
                        }
                    };
                }

                // Firefox
                if (browser.family === 'firefox') {
                    // Firefox uses preferences instead of command line args
                    launchOptions.preferences['media.navigator.permission.disabled'] = true;
                    launchOptions.preferences['media.navigator.streams.fake'] = true;
                    launchOptions.preferences['dom.events.asyncClipboard.readText'] = true;
                    launchOptions.preferences['dom.events.testing.asyncClipboard'] = true;
                }

                return launchOptions;
            });

            // Cypress automatically loads cypress.env.json into config.env
            // We expect config.env to look like { staging: { ... }, prod: { ... } }

            const version = config.env.version || "staging";
            const envConfig = config.env[version];

            if (!envConfig) {
                throw new Error(
                    `Unknown environment version: ${version}. Check cypress.env.json.`
                );
            }

            // Set baseUrl to the dashboardUrl by default
            config.baseUrl = envConfig.dashboardUrl;

            // Merge the specific environment config to the top level of config.env
            // So in tests we can do Cypress.env('auth') or Cypress.env('portalUrl') directly
            config.env = {
                ...config.env,
                ...envConfig,
            };

            return config;
        },
        defaultCommandTimeout: 10000,
        fixturesFolder: 'fixtures',
        // viewportWidth and viewportHeight are set via CLI --config flag
        // Default fallbacks if not provided via CLI
        viewportWidth: process.env.CYPRESS_viewportWidth ? parseInt(process.env.CYPRESS_viewportWidth) : 1280,
        viewportHeight: process.env.CYPRESS_viewportHeight ? parseInt(process.env.CYPRESS_viewportHeight) : 720,
        specPattern: "e2e/suites/**/*.cy.{js,jsx,ts,tsx}",
        supportFile: "support/e2e.js",
        // Enable experimental features for cross-origin testing
        experimentalModifyObstructiveThirdPartyCode: true,
        // Mochawesome reporter for HTML test reports
        reporter: 'mochawesome',
        reporterOptions: {
            reportDir: 'reports',
            overwrite: false,
            html: false,
            json: true,
            timestamp: 'mmddyyyy_HHMMss'
        },
    },
});
