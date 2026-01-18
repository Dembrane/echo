import { loginToApp, logout } from '../../support/functions/login';

describe('Smoke Test Suite', () => {

    it('should be able to visit the login page and attempt login', () => {
        // This test uses the environment configuration
        // baseUrl is set by the config based on env

        // Log the current environment to verify config loading
        cy.log(`Running in environment: ${Cypress.env('env')}`);

        // Attempt login (this will assume 'regular' user if not provided)
        // It will grab credentials from config
        loginToApp();
    });

});
