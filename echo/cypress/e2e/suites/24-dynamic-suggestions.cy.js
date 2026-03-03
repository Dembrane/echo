/**
 * Ask Feature Flow (Dynamic Suggestions) Test Suite
 *
 * This test verifies:
 * 1. Login and create a new project
 * 2. Open Ask (Specific Details) without sending a message
 * 3. Verify initial suggestions state (only static suggestions + more button)
 * 4. Send one message and verify 3 dynamic suggestion chips appear
 * 5. Navigate to Home, delete project, and logout
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import { navigateToProjectOverview } from '../../support/functions/conversation';
import {
    clickSendButton,
    getDynamicSuggestionIds,
    openAskSpecificDetailsWithoutSending,
    typeMessage,
    verifyDynamicSuggestionsAfterMessage,
    verifyInitialSuggestionState,
    waitForAITyping
} from '../../support/functions/chat';

describe('Ask Feature Flow (Dynamic Suggestions)', () => {
    let projectId;

    beforeEach(() => {
        cy.on('uncaught:exception', (err) => {
            if (err.message.includes('Minified React error #185')) {
                return false;
            }
        });
        loginToApp();
    });

    it('should verify suggestions update dynamically after sending first chat message', () => {
        let beforeDynamicSuggestionIds = [];

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

        // 2. Open Ask in Specific Details mode, but do not send yet
        cy.log('Step 2: Opening Ask in Specific Details mode');
        openAskSpecificDetailsWithoutSending();

        // 3. Verify initial suggestion state before first message
        cy.log('Step 3: Verifying initial suggestions before sending message');
        verifyInitialSuggestionState();
        cy.get('[data-testid="chat-templates-more-button"]').should('be.visible');
        getDynamicSuggestionIds().then((ids) => {
            beforeDynamicSuggestionIds = ids;
            cy.log(`Dynamic suggestions before first message: ${ids.length}`);
            expect(ids.length, 'dynamic suggestions before first message').to.equal(0);
        });

        // 4. Send first message
        cy.log('Step 4: Sending first message');
        typeMessage('hello');
        clickSendButton();
        waitForAITyping(90000);

        cy.wait(20000);

        // 5. Verify 3 dynamic suggestions appear after message
        cy.log('Step 5: Verifying dynamic suggestions after first message');
        verifyDynamicSuggestionsAfterMessage(beforeDynamicSuggestionIds, 3, 120000, 3);
        cy.get('[data-testid="chat-template-static-summarize"]').should('be.visible');
        cy.get('[data-testid="chat-template-static-compare-&-contrast"]').should('be.visible');
        cy.get('[data-testid="chat-templates-more-button"]').should('be.visible');
        getDynamicSuggestionIds().then((afterIds) => {
            const uniqueAfterIds = [...new Set(afterIds)];
            expect(uniqueAfterIds.length, 'dynamic suggestions after first message').to.equal(3);
        });

        // 6. Navigate to Project Overview
        cy.log('Step 6: Navigating to Project Overview');
        navigateToProjectOverview();

        // 7. Delete the project
        cy.log('Step 7: Deleting project');
        cy.then(() => {
            deleteProject(projectId);
        });

        // 8. Open Settings menu and Logout
        cy.log('Step 8: Opening settings and logging out');
        openSettingsMenu();
        logout();
    });
});
