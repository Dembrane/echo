export const openSettingsMenu = () => {
    cy.log('Opening Settings Menu');
    // Wait for stability (handling detached DOM / hydration re-render issues)
    cy.wait(2000);
    // Using the robust selector found during login debugging
    cy.xpath('//button[descendant::*[local-name()="svg" and contains(@class, "tabler-icon-settings")]]').click();
    cy.wait(1000); // Wait for menu animation
};

export const changeLanguage = (langCode) => {
    cy.log('Changing language to:', langCode);

    // The language selector is a native select inside the settings menu
    // Selector: select.mantine-NativeSelect-input
    cy.get('select.mantine-NativeSelect-input').should('be.visible').select(langCode);

    // Wait for page reload/navigation if it occurs
    cy.wait(2000);
};

export const verifyLanguage = (expectedLogoutText, expectedUrlLocale) => {
    cy.log('Verifying language change');

    // 1. Verify URL contains the locale (e.g., /es-ES/)
    if (expectedUrlLocale) {
        cy.url().should('include', `/${expectedUrlLocale}/`);
    }

    // 2. Verify Logout button text
    // The menu should be open to check this.
    cy.get('body').then(($body) => {
        // If the dropdown isn't visible, re-open the menu
        if ($body.find('div[role="menu"]').length === 0 && $body.find('.mantine-Menu-dropdown').length === 0) {
            openSettingsMenu();
        }

        // Check Logout button text, robustly finding the div inside the button
        cy.xpath(`//button[descendant::div[contains(text(), "${expectedLogoutText}")]]`).should('be.visible');
    });
};
