import { loginToApp, logout } from '../../support/functions/login';
import { openSettingsMenu } from '../../support/functions/settings';

describe('Login & Logout Flow', () => {

    it('should successfully login and logout', () => {
        // 1. Perform Login
        loginToApp();

        // 2. Open Settings Menu (to access logout)
        openSettingsMenu();

        // 3. Perform Logout
        logout();
    });

});

