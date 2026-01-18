import { loginToApp, logout, verifyLogin } from '../../support/functions/login';

describe('Login & Logout Flow', () => {

    it('should successfully login and logout', () => {
        // 1. Perform Login
        loginToApp();

        // 2. Verify Login
        // We get the email from the environment to verify against what's shown in the UI
        const email = Cypress.env('auth').email;
        verifyLogin(email);

        // 3. Perform Logout
        logout();
    });

});
