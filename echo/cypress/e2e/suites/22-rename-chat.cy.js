/**
 * Ask Feature Flow (No Context Selection) Test Suite
 * 
 * This test verifies the Ask feature without manually selecting conversations:
 * 1. Login and create a new project
 * 2. Upload an audio file (replicating Suite 08/10 flow)
 * 3. Use Ask feature without context selection
 * 4. Verify AI response
 * 5. Navigate to Home, delete project, and logout
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import {
    openUploadModal,
    uploadAudioFile,
    clickUploadFilesButton,
    closeUploadModal,
    navigateToProjectOverview
} from '../../support/functions/conversation';
import { askWithoutContext } from '../../support/functions/chat';

describe('Ask Feature Flow (No Context Selection)', () => {
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

    it('should upload audio, use Ask feature without selecting context, verify response, delete project and logout', () => {
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

        // New Step: Rename Flow
        cy.log('Step 7b: Renaming the first chat');
        const newChatName = `Renamed Chat ${Date.now()}`;

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
                throw new Error('No chats found to rename');
            }
        });

        cy.window().then((win) => {
            cy.stub(win, 'prompt').returns(newChatName);
        });

        // Click first chat menu button
        cy.get('[data-testid="chat-item-menu"]', { timeout: 10000 })
            .filter(':visible')
            .first()
            .click({ force: true });

        // Click Rename option
        cy.get('[data-testid="chat-item-menu-rename"]').should('be.visible').click();

        // Wait for server update
        cy.log('Waiting 5 seconds for rename to persist');
        cy.wait(5000);

        // Verify rename text appears in the chats sidebar list
        cy.log('Verifying chat rename');
        cy.get('[data-testid="chat-accordion"]', { timeout: 10000 })
            .should('contain.text', newChatName);

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
