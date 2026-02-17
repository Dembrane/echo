import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject, updateProjectName, navigateToHome } from '../../support/functions/project';
import { openPortalEditor, selectTutorial, addTag, updatePortalContent, changePortalLanguage, toggleAskForName, toggleAskForEmail } from '../../support/functions/portal';
import { openSettingsMenu } from '../../support/functions/settings';
import { agreeToPrivacyPolicy, clickThroughOnboardingUntilCheckbox, enterSessionName, handleMicrophoneAccessDenied, prepareForRecording, primeMicrophoneAccess, reapplyParticipantAudioStubs, selectTags, startRecording, stopRecording, installParticipantAudioStubs, handleRecordingInterruption, continueMicrophoneCheck, retryRecordingIfAccessDenied, finishRecordingFromModal, confirmFinishConversation } from '../../support/functions/participant';

describe('Project Create, Edit, and Delete Flow', () => {
    beforeEach(() => {
        loginToApp();
    });

    it('should create a project, edit its name and portal settings, verify changes, and delete it', () => {
        const uniqueId = Cypress._.random(0, 10000);
        const newProjectName = `New Project_${uniqueId}`;
        const portalTitle = `Title_${uniqueId}`;
        const portalContent = `Content_${uniqueId}`;
        const thankYouContent = `ThankYou_${uniqueId}`;
        const tagName = `Tag_${uniqueId}`;
        const portalLanguage = 'it'; // Italian
        const sessionName = `Session_${uniqueId}`;

        // 1. Create Project
        createProject();

        let createdProjectId;
        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                createdProjectId = parts[projectIndex + 1];
                cy.log(`Working with Project ID: ${createdProjectId}`);

                // 2. Edit Project Name
                updateProjectName(newProjectName);

                // 3. Edit Portal Settings
                openPortalEditor();
                toggleAskForName(true);
                toggleAskForEmail(true);
                selectTutorial('Advanced');
                addTag(tagName);
                updatePortalContent(portalTitle, portalContent, thankYouContent);


                // 4. Return to Home and Verify Name in List
                navigateToHome();
                cy.wait(2000); // Wait for list reload

                // Check if the project list contains the new name
                // Target the main content area (not the mobile sidebar) using the visible desktop sidebar
                cy.get('main').within(() => {
                    cy.get(`a[href*="${createdProjectId}"]`).first().should('contain.text', newProjectName);
                });

                // 5. Enter Project and Verify Changes
                cy.get('main').within(() => {
                    cy.get(`a[href*="${createdProjectId}"]`).first().click();
                });
                cy.wait(3000); // Wait for dashboard load

                // Check Name on Dashboard - verify in the breadcrumb title
                cy.get('[data-testid="project-breadcrumb-name"]').should('contain.text', newProjectName);

                // Check Portal Settings Persistence
                openPortalEditor();
                // Verify Tag - inside mantine-Badge-label span
                cy.get('.mantine-Badge-label').contains(tagName).should('be.visible');
                // Verify Title Input Value
                cy.get('[data-testid="portal-editor-page-title-input"]').should('have.value', portalTitle);

                cy.url().then((url) => {
                    const parts = url.split('/');
                    const projectIndex = parts.indexOf('projects');
                    if (projectIndex !== -1 && parts[projectIndex + 1]) {
                        projectId = parts[projectIndex + 1];
                        Cypress.env('participantAudioProjectId', projectId);
                        cy.log('Captured Project ID:', projectId);
                    }
                });

                resolveProjectId();
                // 6. Delete Project
                // deleteProject(createdProjectId);
            }
        });


    });

    it('records audio in the participant portal', () => {
        registerExceptionHandling();
        resolveProjectId().then(() => {
            cy.log('Step 2: Opening participant portal');
            // Use WAV for stable chunk sizing across browsers
            cy.readFile('fixtures/test-audio.wav', 'base64').then((audioBase64) => {
                installParticipantAudioStubs({ audioBase64, audioMimeType: 'audio/wav' });
                cy.visit(getPortalUrl());
            });
        });

        clickThroughOnboardingUntilCheckbox();

        agreeToPrivacyPolicy();
        reapplyParticipantAudioStubs();
        primeMicrophoneAccess();

        cy.log('Step 4: Microphone check');
        cy.wait(3000);
        handleMicrophoneAccessDenied();

        cy.contains('button', 'Skip').should('be.visible');

        cy.get('body').then(($body) => {
            const selector = $body.find('[role="combobox"], select');
            if (selector.length > 0) {
                cy.log('Microphone selector present');
            } else {
                cy.log('No microphone selector found - using default device');
            }
        });

        cy.wait(2000);
        reapplyParticipantAudioStubs();
        const allowSkip = Cypress.browser && Cypress.browser.name === 'webkit';
        continueMicrophoneCheck({ allowSkip });

        enterSessionName(sessionName);
        reapplyParticipantAudioStubs();

        cy.log('Step 6: Start Recording');
        handleMicrophoneAccessDenied();
        prepareForRecording();
        reapplyParticipantAudioStubs();
        startRecording();
        retryRecordingIfAccessDenied();

        // Wait for Stop button or handle interruption
        cy.get('body', { timeout: 30000 }).then(($body) => {
            if ($body.find('[data-testid="portal-audio-stop-button"]:visible').length > 0) {
                cy.log('Stop button visible - recording started successfully');
            } else if ($body.find('[data-testid="portal-audio-interruption-reconnect-button"]:visible').length > 0) {
                cy.log('Recording interrupted - reconnecting');
                handleRecordingInterruption();
            }
        });

        cy.log('Recording for 60 seconds...');
        cy.wait(60000);

        // Check for interruption after waiting
        handleRecordingInterruption();

        stopRecording();

        finishRecordingFromModal();
        confirmFinishConversation();
        cy.wait(2000);
    });

});
