export const loginToApp = () => {
    cy.log('Logging in with XPaths');
    const user = Cypress.env('auth');

    if (!user || !user.email) {
        throw new Error('User credentials not found in environment configuration.');
    }

    cy.visit('/');

    // 1. Enter Email: //input[@name='email']
    cy.xpath('//input[@name="email"]').type(user.email);

    // 2. Enter Password: //input[@name="password"]
    cy.xpath('//input[@name="password"]').type(user.password);

    // 3. Click Login Button: //button[@type='submit']
    cy.xpath('//button[@type="submit"]').click();

    // 4. Wait for URL change
    cy.url().should('not.include', '/login');
};

export const verifyLogin = (expectedEmail) => {
    cy.log('Verifying login for', expectedEmail);

    // 1. Click Settings Icon:
    // We use local-name()="svg" to robustly handle SVG namespaces in browsers.
    // Wait for stability as the button might re-render (detached DOM issue)
    cy.wait(2000);
    cy.xpath('//button[descendant::*[local-name()="svg" and contains(@class, "tabler-icon-settings")]]').click();

    // 2. Verify Email OR Logout Button
    // User requested to check for Logout button if email is not visible
    cy.get('body').then(($body) => {
        // Try to find email
        const emailVisible = $body.find(`p:contains("${expectedEmail}")`).length > 0;

        if (emailVisible) {
            cy.xpath(`//p[text()="${expectedEmail}"]`).should('be.visible');
        } else {
            cy.log('Email not found directly, checking for Logout button as fallback verification');
            cy.xpath('//div[text()="Logout"]').should('be.visible');
        }
    });
};

export const logout = () => {
    cy.log('Logging out');

    // 1. Click Logout Button in the menu: //div[text()='Logout']
    // We assume the menu is already open when this function is called.
    // The previous selector was //button[.//div[text()="Logout"]]
    // We use a robust XPath that finds the button containing the text "Logout"
    cy.xpath('//button[descendant::*[contains(text(), "Logout")]]').should('be.visible').click();

    // 2. Verify redirected to login
    cy.xpath('//input[@name="email"]').should('be.visible');
};
