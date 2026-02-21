describe('Register Flow', () => {
    const registerExceptionHandling = () => {
        cy.on('uncaught:exception', (err) => {
            if (
                err.message.includes('ResizeObserver loop limit exceeded') ||
                err.message.includes('Request failed with status code')
            ) {
                return false;
            }
            return true;
        });
    };

    const openRegisterForm = () => {
        cy.visit('/');
        cy.get('[data-testid="auth-login-email-input"]').should('be.visible');
        cy.get('[data-testid="auth-login-register-button"]').filter(':visible').first().click();
        cy.get('[data-testid="auth-register-first-name-input"]').should('be.visible');
    };

    const buildUserData = () => {
        const uniqueId = `${Date.now()}_${Cypress._.random(1000, 9999)}`;
        return {
            firstName: `Auto${uniqueId}`,
            lastName: `User${uniqueId}`,
            email: `autotest.${uniqueId}@gmail.com`,
            password: `EchoTest@${Cypress._.random(100000, 999999)}`
        };
    };

    const fillRegisterForm = ({
        firstName,
        lastName,
        email,
        password,
        confirmPassword
    }) => {
        cy.get('[data-testid="auth-register-first-name-input"]').clear().type(firstName);
        cy.get('[data-testid="auth-register-last-name-input"]').clear().type(lastName);
        cy.get('[data-testid="auth-register-email-input"]').clear().type(email);
        cy.get('[data-testid="auth-register-password-input"]').clear().type(password);
        cy.get('[data-testid="auth-register-confirm-password-input"]').clear().type(confirmPassword);
    };

    beforeEach(() => {
        registerExceptionHandling();
        openRegisterForm();
    });

    it('opens register screen from login link and shows all required fields', () => {
        cy.contains('h1', 'Create an Account').should('be.visible');
        cy.get('[data-testid="auth-register-first-name-input"]').should('be.visible');
        cy.get('[data-testid="auth-register-last-name-input"]').should('be.visible');
        cy.get('[data-testid="auth-register-email-input"]').should('be.visible');
        cy.get('[data-testid="auth-register-password-input"]').should('be.visible');
        cy.get('[data-testid="auth-register-confirm-password-input"]').should('be.visible');
        cy.get('[data-testid="auth-register-submit-button"]').should('be.visible');
    });

    it('shows validation error when passwords do not match', () => {
        const user = buildUserData();

        fillRegisterForm({
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            password: user.password,
            confirmPassword: `${user.password}_mismatch`
        });

        cy.get('[data-testid="auth-register-submit-button"]').click();
        cy.contains('Passwords do not match').should('be.visible');
    });

    it('submits registration with matching passwords and shows check email screen', () => {
        const user = buildUserData();

        fillRegisterForm({
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            password: user.password,
            confirmPassword: user.password
        });

        cy.get('[data-testid="auth-register-submit-button"]').click();

        cy.get('[data-testid="auth-check-email-title"]', { timeout: 20000 })
            .should('be.visible')
            .and('contain.text', 'Check your email');

        cy.get('[data-testid="auth-check-email-text"]')
            .should('be.visible')
            .and('contain.text', 'We have sent you an email with next steps.');
    });
});
