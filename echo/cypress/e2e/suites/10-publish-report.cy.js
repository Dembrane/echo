/**
 * Publish Report Flow Test Suite
 * 
 * This test extends the report creation flow to verify publishing:
 * 1. Login and create a new project
 * 2. Upload an audio file
 * 3. Create a report
 * 4. Toggle "Publish" to enable public access
 * 5. Copy the public link
 * 6. Visit the public link in a new view
 * 7. Verify public report content
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

describe('Publish Report Flow', () => {
    let projectId;

    beforeEach(() => {
        // Handle uncaught exceptions
        cy.on('uncaught:exception', (err, runnable) => {
            if (err.message.includes('Syntax error, unrecognized expression') ||
                err.message.includes('BODY[style=') ||
                err.message.includes('ResizeObserver loop limit exceeded')) {
                return false;
            }
            return true;
        });
        loginToApp();
    });

    it('should upload audio, create report, publish it, and verify public link', () => {
        // 1. Create new project
        cy.log('Step 1: Creating new project');
        createProject();

        // Capture project ID for deletion
        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                projectId = parts[projectIndex + 1];
                console.log('Captured Project ID:', projectId);
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

        // 10. Click on the Report button again to verify/publish
        cy.log('Step 10: Clicking Report button again to open report');
        cy.xpath("//button[contains(., 'Report')]").filter(':visible').click();
        cy.wait(5000); // Wait for report content to load

        // 11. Publish the report
        cy.log('Step 11: Toggling Publish switch');

        // Target the label containing 'Publish' (or Published) and click it
        cy.xpath("//label[.//span[contains(text(), 'Publish')]]").filter(':visible').click();

        // Wait for the copy button to be interactive
        cy.wait(2000);

        // 12. copy functionality verification via URL construction
        // Use cy.then to ensure projectId is available (captured in previous async step)
        cy.then(() => {
            cy.log('Step 12: Verifying publish by visiting public URL');

            // Get the portal URL from environment config
            const portalUrl = Cypress.env('portalUrl');
            // Ensure no trailing slash
            let cleanPortalUrl = '';
            if (portalUrl) {
                cleanPortalUrl = portalUrl.replace(/\/$/, '');
            } else {
                // Fallback if env var is missing/empty, though tests should fail earlier
                throw new Error('portalUrl environment variable is not set');
            }

            // Construct the expected public URL: https://portal.../en-US/{projectId}/report
            const publicUrl = `${cleanPortalUrl}/en-US/${projectId}/report`;

            cy.log('Target Public URL:', publicUrl);

            // 13. Visit the public link
            // Since this is a different domain/subdomain, cy.visit works fine.
            cy.visit(publicUrl);

            // 14. Verify Public Page Elements using cy.origin
            // Since the public URL is on a different superdomain (portal vs dashboard), we need cy.origin
            cy.origin(publicUrl, () => {
                cy.log('Step 14: Verifying public report page inside origin');
                // Ensure page loads
                cy.get('body', { timeout: 10000 }).should('be.visible');

                // Using standard selectors inside origin to avoid 'cy.xpath is not a function' error
                // (Plugins are not automatically loaded in cy.origin context)
                cy.get('img[alt="Dembrane Logo"]').should('be.visible');
                cy.contains('h1', 'Dembrane').should('be.visible');
                cy.contains('p', 'Report').should('be.visible');
            });

            // 15. Return to App for Cleanup
            // Navigate back to the specific project page in the dashboard to ensure context for deletion
            cy.log('Step 15: Returning to project page');
            const dashboardUrl = Cypress.env('dashboardUrl');
            const dashboardProjectUrl = `${dashboardUrl}/projects/${projectId}`;
            cy.visit(dashboardProjectUrl);

            // Wait for app load
            cy.wait(5000);

            // 16. Delete the project
            // Now that we are back in the app and on the project page (or at least authenticated dashboard), 
            // deleteProject can function correctly.
            cy.log('Step 16: Deleting project');
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
