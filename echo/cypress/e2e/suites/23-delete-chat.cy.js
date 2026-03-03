/**
 * Ask Feature Flow (Delete Chat) Test Suite
 *
 * This test verifies:
 * 1. Login and create a new project
 * 2. Use Ask feature without context
 * 3. Delete the created chat and accept browser confirm popup
 * 4. Verify chats empty state
 * 5. Navigate to Home, delete project, and logout
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import { navigateToProjectOverview } from '../../support/functions/conversation';
import { askWithoutContext } from '../../support/functions/chat';

describe('Ask Feature Flow (Delete Chat)', () => {
    let projectId;

    beforeEach(() => {
        // Suppress known Minified React error #185
        cy.on('uncaught:exception', (err, runnable) => {
            if (err.message.includes('Minified React error #185')) {
                return false;
            }
        });
        loginToApp();
    });

    it('should upload audio, use Ask feature, delete chat, verify empty chats state, delete project and logout', () => {
        // 1. Create new project
        cy.log('Step 1: Creating new project');
        createProject();

        // Capture project ID for deletion
        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                projectId = parts[projectIndex + 1];
                cy.log('Captured Project ID:', projectId);
            }
        });


        // 7. Use Ask feature without context selection
        cy.log('Step 7: Using Ask feature without context');
        askWithoutContext('hello');

        // New Step: Delete Flow
        cy.log('Step 7b: Deleting the first chat');

        // Ensure Chats accordion is expanded (avoid toggling it closed by accident)
        cy.get('[data-testid="chat-accordion"] [data-accordion-control="true"]')
            .filter(':visible')
            .first()
            .then(($control) => {
                if ($control.attr('aria-expanded') !== 'true') {
                    cy.wrap($control).click();
                }
            });
        cy.wait(1500);

        // Verify chats exist or fail gracefully with info
        cy.get('body').then($body => {
            if ($body.find('[data-testid="chat-accordion-empty-text"]').length > 0) {
                cy.log('No chats found in the list!');
                throw new Error('No chats found to delete');
            }
        });

        // Accept browser confirmation popup when deleting
        cy.on('window:confirm', () => {
            return true;
        });

        // Click first chat menu button
        cy.get('[data-testid="chat-item-menu"]', { timeout: 10000 })
            .filter(':visible')
            .first()
            .click({ force: true });

        // Click Delete option and proceed with browser confirm
        cy.get('[data-testid="chat-item-menu-delete"]')
            .filter(':visible')
            .first()
            .click({ force: true });

        // Wait for server update
        cy.log('Waiting 5 seconds for delete to persist');
        cy.wait(5000);

        // Verify chats empty state
        cy.log('Verifying chats empty state after delete');
        cy.get('[data-testid="chat-accordion-empty-text"]', { timeout: 10000 })
            .should('be.visible')
            .and('contain.text', 'No chats found. Start a chat using the "Ask" button.');

        // 8. Navigate to Project Overview
        cy.log('Step 8: Navigating to Project Overview');
        navigateToProjectOverview();

        // 9. Delete the project
        cy.log('Step 9: Deleting project');
        cy.then(() => {
            deleteProject(projectId);
        });

        // 10. Open Settings menu and Logout
        cy.log('Step 10: Opening settings and logging out');
        openSettingsMenu();
        logout();
    });
});
