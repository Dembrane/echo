/**
 * Edit Report Flow Test Suite
 * 
 * This test verifies the flow of creating a report and editing its content:
 * 1. Login and create a new project
 * 2. Upload an audio file
 * 3. Create a report
 * 4. Toggle "Editing mode"
 * 5. Modify the report content
 * 6. Toggle "Editing mode" OFF
 * 7. Verify the modifications are visible
 * 8. Cleanup
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

describe('Edit Report Flow', () => {
    let projectId;

    beforeEach(() => {
        // Handle uncaught exceptions
        cy.on('uncaught:exception', (err, runnable) => {
            return false;
        });
        loginToApp();
    });

    it('should upload audio, create report, edit content, and verify changes', () => {
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

        // 2. Open Upload Conversation modal
        cy.log('Step 2: Opening upload modal');
        openUploadModal();

        // 3. Upload the audio file from cypress assets
        cy.log('Step 3: Uploading audio file');
        uploadAudioFile('assets/videoplayback.mp3');

        // 4. Click Upload Files button to start the upload
        cy.log('Step 4: Clicking Upload Files button');
        clickUploadFilesButton();

        // 5. Wait 15 seconds for processing
        cy.log('Step 5: Waiting 15 seconds for file processing');
        cy.wait(15000);

        // 6. Close the upload modal
        cy.log('Step 6: Closing upload modal');
        closeUploadModal();

        // 7. Click on the Report button
        cy.log('Step 7: Clicking Report button');
        cy.xpath("//button[contains(., 'Report')]").filter(':visible').click();

        // 8. Click Create Report in the modal
        cy.log('Step 8: Clicking Create Report in modal');
        cy.get('section[role="dialog"]').should('be.visible');
        cy.xpath("//button[contains(., 'Create Report')]").filter(':visible').click();

        // 9. Wait 20 seconds for processing
        cy.log('Step 9: Waiting 20 seconds for report processing');
        cy.wait(20000);

        // 10. Click on the Report button again to view report
        cy.log('Step 10: Clicking Report button again');
        cy.xpath("//button[contains(., 'Report')]").filter(':visible').click();
        cy.wait(5000); // Wait for report content to load

        // 11. Toggle Editing Mode ON
        cy.log('Step 11: Toggling Editing Mode ON');
        // Use robust xpath for the switch containing 'Editing mode'
        cy.xpath("//label[.//span[contains(text(), 'Editing mode')]]").filter(':visible').click();
        cy.wait(1000); // Wait for editor to initialize

        // 12. Modify Report Content
        cy.log('Step 12: Modifying report content');

        // Locate the contenteditable div within the mdxeditor
        // Based on user provided HTML: class="_contentEditable_sects_380 ... " contenteditable="true"
        cy.get('div[contenteditable="true"]').should('be.visible').then(($editor) => {
            // Clear existing content and type new content
            // Using {selectall}{backspace} to clear ensuring we don't break the editor state
            // processing: { force: true } added to bypass "element hidden" errors
            cy.wrap($editor).type('{selectall}{backspace}', { force: true });
            cy.wait(500);

            // Type new markdown content
            // We use '# ' for Heading 1 and then a paragraph
            cy.wrap($editor).type('# Automated Edit Verification{enter}This is a test edit from Cypress.', { force: true });
        });

        cy.wait(1000); // Wait for auto-save or state update

        // 13. Toggle Editing Mode OFF
        cy.log('Step 13: Toggling Editing Mode OFF');
        cy.xpath("//label[.//span[contains(text(), 'Editing mode')]]").filter(':visible').click();
        cy.wait(1000); // Wait for read-only view validation

        // 14. Verify New Content Persists
        cy.log('Step 14: Verifying edited content');

        // Check for the H1 heading
        cy.contains('h1', 'Automated Edit Verification').should('be.visible');

        // Check for the paragraph text
        cy.contains('p', 'This is a test edit from Cypress.').should('be.visible');

        // 15. Navigate back via Project Overview
        cy.log('Step 15: Navigating to Project Overview');
        // Ensure manual return to project page to reliably use cleanup
        const dashboardUrl = Cypress.env('dashboardUrl');
        if (projectId && dashboardUrl) {
            const dashboardProjectUrl = `${dashboardUrl}/projects/${projectId}`;
            cy.visit(dashboardProjectUrl);
        } else {
            navigateToProjectOverview();
        }
        cy.wait(3000);

        // 16. Delete the project
        cy.log('Step 16: Deleting project');
        cy.then(() => {
            if (projectId) {
                deleteProject(projectId);
            }
        });

        // 17. Open Settings menu and Logout
        cy.log('Step 17: Opening settings and logging out');
        openSettingsMenu();
        logout();
    });
});
