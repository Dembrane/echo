/**
 * Participant Audio Recording Flow Test Suite
 *
 * This flow is split across single-origin tests so it can run in Chromium,
 * Firefox, and WebKit without relying on cy.origin().
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import { clickTranscriptTab, navigateToProjectOverview, selectConversation } from '../../support/functions/conversation';
import {
    agreeToPrivacyPolicy,
    enterSessionName,
    startRecording,
    stopRecording,
    installParticipantAudioStubs,
    reapplyParticipantAudioStubs,
    primeMicrophoneAccess,
    handleMicrophoneAccessDenied,
    continueMicrophoneCheck,
    confirmFinishConversation,
    finishRecordingFromModal,
    retryRecordingIfAccessDenied,
    prepareForRecording,
} from '../../support/functions/participant';

describe('Participant Audio Recording Flow', () => {
    let projectId;

    const portalBaseUrl = Cypress.env('portalUrl') || 'https://portal.echo-next.dembrane.com';
    const dashboardBaseUrl = Cypress.env('dashboardUrl') || 'https://dashboard.echo-next.dembrane.com';
    const portalLocale = 'en-US';
    const sessionName = 'Audio Test Session';

    const registerExceptionHandling = () => {
        cy.on('uncaught:exception', (err) => {
            if (err.message.includes('Syntax error, unrecognized expression') ||
                err.message.includes('BODY[style=') ||
                err.message.includes('ResizeObserver loop limit exceeded')) {
                return false;
            }
            return true;
        });
    };

    const resolveProjectId = () => {
        return cy.then(() => {
            if (!projectId) {
                projectId = Cypress.env('participantAudioProjectId');
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
                Cypress.env('participantAudioProjectId', projectId);
                return projectId;
            });
        }).then((id) => {
            expect(id, 'projectId').to.be.a('string').and.not.be.empty;
        });
    };

    const getPortalUrl = () => `${portalBaseUrl}/${portalLocale}/${projectId}/start`;

    it('creates a project for participant audio recording', () => {
        registerExceptionHandling();
        loginToApp();

        cy.log('Step 1: Creating new project');
        createProject();

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

        // Keep the session intact for the remaining flow parts.
    });

    it('records audio in the participant portal', () => {
        registerExceptionHandling();
        resolveProjectId().then(() => {
            cy.log('Step 2: Opening participant portal');
            cy.fixture('test-audio.wav', 'base64').then((audioBase64) => {
                installParticipantAudioStubs({ audioBase64, audioMimeType: 'audio/wav' });
                cy.visit(getPortalUrl());
            });
        });

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
        startRecording();
        retryRecordingIfAccessDenied();

        cy.contains('button', 'Stop', { timeout: 20000 }).should('be.visible');

        cy.log('Recording for 60 seconds...');
        cy.wait(60000);

        stopRecording();

        finishRecordingFromModal();
        confirmFinishConversation();
        cy.wait(2000);
    });

    it('verifies transcription and cleans up', () => {
        registerExceptionHandling();
        loginToApp();

        resolveProjectId().then(() => {
            cy.visit(`${dashboardBaseUrl}/${portalLocale}/projects/${projectId}/overview`);
        });

        cy.wait(5000);
        selectConversation(sessionName);

        cy.log('Waiting for transcript processing...');
        cy.wait(15000);

        clickTranscriptTab();

        cy.xpath('//div[contains(@class, "mantine-Paper-root")]//div[contains(@style, "flex")]//div/p[contains(@class, "mantine-Text-root")]')
            .should('have.length.gt', 0)
            .then(($els) => {
                const text = $els.text();
                cy.log('Transcribed text:', text);
                expect(text).to.not.be.empty;
            });

        navigateToProjectOverview();
        cy.then(() => {
            deleteProject(projectId);
        });

        openSettingsMenu();
        logout();
    });
});
