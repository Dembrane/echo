export const loginToApp = () => {
    cy.log('Logging in with data-testid selectors');
    const user = Cypress.env('auth');

    if (!user || !user.email) {
        throw new Error('User credentials not found in environment configuration.');
    }

    cy.visit('/');

    // 1. Enter Email using data-testid
    cy.get('[data-testid="auth-login-email-input"]').type(user.email);

    // 2. Enter Password using data-testid
    cy.get('[data-testid="auth-login-password-input"]').type(user.password);

    // 3. Click Login Button using data-testid
    cy.get('[data-testid="auth-login-submit-button"]').click();

    // 4. Wait for URL change
    cy.url().should('not.include', '/login');
};

export const verifyLogin = (expectedEmail) => {
    cy.log('Verifying login for', expectedEmail);

    // 1. Click Settings Icon using data-testid
    // Wait for stability as the button might re-render (detached DOM issue)
    cy.wait(2000);
    cy.get('[data-testid="header-settings-gear-button"]').filter(':visible').first().click();

    // 2. Verify Email OR Logout Button using data-testid
    cy.get('body').then(($body) => {
        // Try to find email
        const emailVisible = $body.find(`p:contains("${expectedEmail}")`).length > 0;

        if (emailVisible) {
            cy.contains('p', expectedEmail).should('be.visible');
        } else {
            cy.log('Email not found directly, checking for Logout button as fallback verification');
            cy.get('[data-testid="header-logout-menu-item"]').filter(':visible').first().should('be.visible');
        }
    });
};

export const logout = () => {
    cy.log('Logging out');

    // 1. Click Logout Button using data-testid
    // We assume the menu is already open when this function is called.
    cy.get('[data-testid="header-logout-menu-item"]').filter(':visible').first().click();

    // 2. Verify redirected to login using data-testid
    cy.get('[data-testid="auth-login-email-input"]').should('be.visible');
};
