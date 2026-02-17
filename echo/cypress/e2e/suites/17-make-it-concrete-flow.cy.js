/**
 * Make it Concrete Flow
 * 
 * This test verifies the "Make it concrete" participant flow.
 * It is split into multiple tests to handle cross-origin navigation boundaries (Dashboard -> Portal -> Dashboard)
 * ensuring stability across WebKit and other browsers.
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import {
    openPortalEditor,
    toggleMakeItConcrete,
    toggleOpenForParticipation
} from '../../support/functions/portal';
import {
    installParticipantAudioStubs,
    reapplyParticipantAudioStubs,
    startRecording,
    stopRecording,
    clickEchoButton,
    selectMakeItConcrete,
    selectVerifyTopic,
    proceedFromTopicSelection,
    approveArtefact,
    finishRecordingFromModal,
    confirmFinishConversation,

    proceedFromInstructions,
    primeMicrophoneAccess,
    handleMicrophoneAccessDenied,
    continueMicrophoneCheck,
    prepareForRecording,
    agreeToPrivacyPolicy,
    enterSessionName,
    retryRecordingIfAccessDenied,
    handleRecordingInterruption
} from '../../support/functions/participant';
import {
    verifySelectedTags,
    navigateToProjectOverview
} from '../../support/functions/conversation';

describe('Make it Concrete Flow', () => {
    let projectId;
    const concreteTopic = 'What we actually agreed on';
    const portalBaseUrl = Cypress.env('portalUrl') || 'https://portal.echo-next.dembrane.com';
    const dashboardBaseUrl = Cypress.env('dashboardUrl') || 'https://dashboard.echo-next.dembrane.com';
    const portalLocale = 'en-US';
    const sessionName = 'Concrete Test Session'; // Name for the participant session

    // Same exception handling as Test 14
    const registerExceptionHandling = () => {
        cy.on('uncaught:exception', (err) => {
            if (err.message.includes('Syntax error, unrecognized expression') ||
                err.message.includes('BODY[style=') ||
                err.message.includes('ResizeObserver loop limit exceeded') ||
                err.message.includes('Can\'t find variable: MediaRecorder')) {
                return false;
            }
            return true;
        });
    };

    // Helper to persist/retrieve Project ID across tests
    const resolveProjectId = () => {
        return cy.then(() => {
            if (!projectId) {
                projectId = Cypress.env('participantConcreteProjectId');
            }

            if (projectId) {
                return projectId;
            }

            return cy.readFile('fixtures/createdProjects.json', { log: false }).then((projects) => {
                const lastProject = Array.isArray(projects) ? projects[projects.length - 1] : null;
                if (!lastProject || !lastProject.id) {
                    throw new Error('projectId not found. Ensure the create step completed successfully.');
                }
                projectId = lastProject.id;
                Cypress.env('participantConcreteProjectId', projectId);
                return projectId;
            });
        }).then((id) => {
            expect(id, 'projectId').to.be.a('string').and.not.be.empty;
        });
    };

    const getPortalUrl = () => `${portalBaseUrl}/${portalLocale}/${projectId}/start`;

    it('Step 1: Creates a project and enables Make it Concrete', () => {
        registerExceptionHandling();
        loginToApp();

        cy.log('Creating new project');
        createProject();

        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                projectId = parts[projectIndex + 1];
                Cypress.env('participantConcreteProjectId', projectId);
                cy.log('Captured Project ID:', projectId);
            }
        });

        resolveProjectId();

        cy.log('Enabling Make it concrete in Portal Editor');
        openPortalEditor();
        toggleMakeItConcrete(true);
        // toggleOpenForParticipation(true);
    });

    it('Step 2: Participant records audio and uses Make it Concrete', () => {
        registerExceptionHandling();

        resolveProjectId().then(() => {
            cy.log('Opening participant portal');
            // Use local fixtures path pattern or 'fixtures/...' depending on setup. 
            // Test 14 uses 'fixtures/test-audio.wav'.
            cy.readFile('fixtures/test-audio.wav', 'base64').then((audioBase64) => {
                installParticipantAudioStubs({ audioBase64, audioMimeType: 'audio/wav' });
                cy.visit(getPortalUrl());
            });
        });

        // Exact flow from Test 14
        agreeToPrivacyPolicy();
        reapplyParticipantAudioStubs();
        primeMicrophoneAccess();

        cy.log('Microphone check');
        cy.wait(3000);
        handleMicrophoneAccessDenied();

        // Check for 'Skip' availability logic from Test 14 (simplified for this flow, but good to have)
        cy.get('[data-testid="portal-onboarding-mic-skip-button"]').should('be.visible');

        cy.wait(2000);
        reapplyParticipantAudioStubs();
        const allowSkip = Cypress.browser && Cypress.browser.name === 'webkit';
        continueMicrophoneCheck({ allowSkip });

        enterSessionName(sessionName);
        reapplyParticipantAudioStubs();

        cy.log('Start Recording Flow');
        handleMicrophoneAccessDenied();
        prepareForRecording();
        reapplyParticipantAudioStubs();
        startRecording();
        retryRecordingIfAccessDenied();

        // Wait for Stop button or handle interruption logic from Test 14
        cy.get('body', { timeout: 30000 }).then(($body) => {
            if ($body.find('[data-testid="portal-audio-stop-button"]:visible').length > 0) {
                cy.log('Stop button visible - recording started successfully');
            } else if ($body.find('[data-testid="portal-audio-interruption-reconnect-button"]:visible').length > 0) {
                cy.log('Recording interrupted - reconnecting');
                handleRecordingInterruption();
            }
        });

        // Record for 60+ seconds as required for Refine button
        cy.log('Recording for 65 seconds to enable Refine...');
        cy.wait(65000);



        // Note: We do NOT finishRecordingFromModal() here because we want to use Refine -> Make it Concrete
        // Verify Refine/Echo button is visible
        cy.log('Refine -> Make it concrete');
        // We might need to wait a moment for the post-recording options to appear
        cy.wait(2000);

        clickEchoButton();
        selectMakeItConcrete();

        // Select Topic & Next
        cy.log('Selecting Topic');
        selectVerifyTopic('agreements'); // "What we actually agreed on"
        proceedFromTopicSelection();

        // Wait for submission/processing
        cy.wait(40000);
        proceedFromInstructions();
        cy.wait(20000);
        approveArtefact();
        cy.wait(1000);

        // Verify the concrete object is created and visible
        cy.get('[data-testid="portal-verified-artefact-item-0"]')
            .should('be.visible')
            .and('contain', 'What we actually agreed on');

        stopRecording();
        cy.wait(1000);
        finishRecordingFromModal();
        confirmFinishConversation();
        cy.wait(2000);




    });

    it('Step 3: Dashboard verification and cleanup', () => {
        registerExceptionHandling();
        loginToApp();

        resolveProjectId().then(() => {
            cy.visit(`${dashboardBaseUrl}/projects/${projectId}/overview`);
        });

        // Select the conversation (it should be the only one, or most recent)
        // Ensure we click the visible one (desktop view) to avoid clicking hidden mobile elements
        cy.get('[data-testid^="conversation-item-"]').filter(':visible').first().click();

        // Verify Conversation Overview sections
        cy.log('Verifying Conversation Overview');
        // cy.contains('h2', 'Summary').should('be.visible');
        // cy.contains('h2', 'Artefacts').should('be.visible');
        // cy.contains('h2', 'Edit Conversation').should('be.visible');

        // Verify Concrete Artefact
        cy.log('Verifying concrete artefact presence');
        cy.get('[data-testid="conversation-artefacts-accordion"]')
            .scrollIntoView()
            .should('be.visible')
            .within(() => {
                cy.contains('What we actually agreed on').should('be.visible');
            });


        // Cleanup
        cy.log('Cleanup - Deleting Project');
        navigateToProjectOverview();
        cy.then(() => {
            if (projectId) {
                deleteProject(projectId);
            }
        });

        // Logout
        openSettingsMenu();
        logout();
    });
});
