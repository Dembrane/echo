export const openSettingsMenu = () => {
    cy.log('Opening Settings Menu');
    // Wait for stability (handling detached DOM / hydration re-render issues)
    cy.wait(2000);
    // Using data-testid for robust selection - filter visible for mobile/desktop duplicates
    cy.get('[data-testid="header-settings-gear-button"]').filter(':visible').first().click();
    cy.wait(1000); // Wait for menu animation
};

export const changeLanguage = (langCode) => {
    cy.log('Changing language to:', langCode);

    // The language selector uses data-testid="header-language-picker"
    cy.get('[data-testid="header-language-picker"]').filter(':visible').first().select(langCode);

    // Wait for page reload/navigation if it occurs
    cy.wait(2000);
};

export const verifyLanguage = (expectedLogoutText, expectedUrlLocale) => {
    cy.log('Verifying language change');

    // 1. Verify URL contains the locale (e.g., /es-ES/)
    if (expectedUrlLocale) {
        cy.url().should('include', `/${expectedUrlLocale}/`);
    }

    // 2. Verify Logout button is visible using data-testid
    // The menu should be open to check this.
    cy.get('body').then(($body) => {
        // If the dropdown isn't visible, re-open the menu
        if ($body.find('div[role="menu"]').length === 0 && $body.find('.mantine-Menu-dropdown').length === 0) {
            openSettingsMenu();
        }

        // Check Logout button text using data-testid - filter visible for mobile/desktop duplicates
        cy.get('[data-testid="header-logout-menu-item"]').filter(':visible').first()
            .contains(expectedLogoutText);
    });
};

