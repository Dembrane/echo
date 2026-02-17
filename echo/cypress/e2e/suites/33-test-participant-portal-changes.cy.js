import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject, updateProjectName, navigateToHome } from '../../support/functions/project';
import { openPortalEditor, selectTutorial, addTag, updatePortalContent, toggleAskForName, toggleAskForEmail } from '../../support/functions/portal';
import { openSettingsMenu } from '../../support/functions/settings';
import { agreeToPrivacyPolicy, clickThroughOnboardingUntilCheckbox, clickThroughOnboardingUntilMicrophone, typeSessionName, verifyAndSelectTag, submitSessionForm, switchToTextMode, typePortalText, submitText, finishTextMode, confirmFinishText, enterNotificationEmail, submitEmailNotification } from '../../support/functions/participant';

describe('Project Create, Edit, and Delete Flow', () => {
    let projectId;
    let locale = 'en-US';

    const localeSegmentPattern = /^[a-z]{2}-[A-Z]{2}$/;
    const portalBaseUrl = (Cypress.env('portalUrl') || 'https://portal.echo-next.dembrane.com').replace(/\/$/, '');
    const dashboardBaseUrl = (Cypress.env('dashboardUrl') || '').replace(/\/$/, '');

    const projectIdEnvKey = 'participantAudioProjectId';
    const participantLinkEnvKey = 'participantUrl';
    const localeEnvKey = 'participantLocale';
    const tagEnvKey = 'participantTagName';
    const thankYouEnvKey = 'participantThankYouContent';

    const registerExceptionHandling = () => {
        cy.on('uncaught:exception', (err) => {
            if (err.message.includes('Syntax error, unrecognized expression') ||
                err.message.includes('BODY[style=') ||
                err.message.includes('ResizeObserver loop limit exceeded') ||
                err.message.includes('Request failed with status code')) {
                return false;
            }
            return true;
        });
    };

    const buildDashboardProjectUrl = (id, page) => {
        if (!dashboardBaseUrl) {
            return `/${locale}/projects/${id}/${page}`;
        }

        const baseUrl = new URL(`${dashboardBaseUrl}/`);
        const basePathSegments = baseUrl.pathname.split('/').filter(Boolean);
        const baseHasLocale = basePathSegments.some((segment) => localeSegmentPattern.test(segment));
        const relativePath = baseHasLocale
            ? `projects/${id}/${page}`
            : `${locale}/projects/${id}/${page}`;

        return new URL(relativePath, baseUrl).toString();
    };

    const clickVisibleCopyLinkButton = () => {
        cy.get('[data-testid="project-copy-link-button"]').then(($buttons) => {
            const $visibleButtons = $buttons.filter((index, button) => Cypress.$(button).is(':visible'));
            if ($visibleButtons.length > 0) {
                cy.wrap($visibleButtons.first()).click();
                return;
            }
            cy.wrap($buttons.first()).click({ force: true });
        });
    };

    const resolveProjectId = () => {
        return cy.then(() => {
            if (!projectId) {
                projectId = Cypress.env(projectIdEnvKey);
            }
            if (Cypress.env(localeEnvKey)) {
                locale = Cypress.env(localeEnvKey);
            }

            if (projectId) {
                return projectId;
            }

            return cy.readFile('fixtures/createdProjects.json', { log: false }).then((projects) => {
                const lastProject = Array.isArray(projects) ? projects[projects.length - 1] : null;
                if (!lastProject || !lastProject.id) {
                    throw new Error('projectId not found. Ensure the setup test completed successfully.');
                }
                projectId = lastProject.id;
                Cypress.env(projectIdEnvKey, projectId);
                return projectId;
            });
        }).then((id) => {
            expect(id, 'projectId').to.be.a('string').and.not.be.empty;
            return id;
        });
    };

    const resolveParticipantUrl = () => {
        return cy.then(() => {
            const existingLink = Cypress.env(participantLinkEnvKey);
            if (existingLink && existingLink.trim().length > 0) {
                return existingLink.trim();
            }

            return resolveProjectId().then((id) => {
                const fallbackLink = `${portalBaseUrl}/${locale}/${id}/start`;
                Cypress.env(participantLinkEnvKey, fallbackLink);
                return fallbackLink;
            });
        }).then((link) => {
            expect(link, 'participant link').to.be.a('string').and.not.be.empty;
            return link;
        });
    };

    // beforeEach(() => {
    //     loginToApp();
    // });

    // Shared variables are stored in Cypress.env to persist across tests in the same suite

    it('Part 1: Admin Setup - Create Project and Configure Portal', () => {
        registerExceptionHandling();
        loginToApp();
        const uniqueId = Cypress._.random(0, 10000);
        const newProjectName = `New Project_${uniqueId}`;
        const portalTitle = `Title_${uniqueId}`;
        const portalContent = `Content_${uniqueId}`;
        const thankYouContent = `ThankYou_${uniqueId}`;
        const tagName = `Tag_${uniqueId}`;
        const portalLanguage = 'it'; // Italian

        // 1. Create Project
        createProject();

        cy.location('pathname').then((pathname) => {
            const pathSegments = pathname.split('/').filter(Boolean);
            const projectIndex = pathSegments.indexOf('projects');
            if (projectIndex !== -1 && pathSegments[projectIndex + 1]) {
                const createdProjectId = pathSegments[projectIndex + 1];
                const localeSegment = pathSegments[projectIndex - 1];
                if (localeSegment && localeSegmentPattern.test(localeSegment)) {
                    locale = localeSegment;
                }
                cy.log(`Working with Project ID: ${createdProjectId}`);

                // Save to env for subsequent tests
                projectId = createdProjectId;
                Cypress.env(projectIdEnvKey, createdProjectId);
                Cypress.env(localeEnvKey, locale);
                Cypress.env(tagEnvKey, tagName);
                Cypress.env(thankYouEnvKey, thankYouContent);
                Cypress.env('portalLanguage', portalLanguage); // Save language too

                // 2. Edit Project Name
                updateProjectName(newProjectName);

                // 3. Edit Portal Settings
                openPortalEditor();
                toggleAskForName(true);
                toggleAskForEmail(true);
                selectTutorial('Basic');
                addTag(tagName);
                updatePortalContent(portalTitle, portalContent, thankYouContent);

                // 4. Return to Home and Verify Name in List
                navigateToHome();
                cy.wait(2000); // Wait for list reload

                // Check if the project list contains the new name
                cy.get('main').within(() => {
                    cy.get(`a[href*="${createdProjectId}"]`).first().should('contain.text', newProjectName);
                });

                // 5. Enter Project and Verify Changes
                cy.get('main').within(() => {
                    cy.get(`a[href*="${createdProjectId}"]`).first().click();
                });
                cy.wait(3000); // Wait for dashboard load

                // Check Name on Dashboard
                cy.get('[data-testid="project-breadcrumb-name"]').should('contain.text', newProjectName);

                clickVisibleCopyLinkButton();

                // Wait for copy action
                cy.wait(1000);

                // Store participant URL from clipboard with fallback.
                cy.window().then((win) => {
                    if (win.navigator.clipboard && typeof win.navigator.clipboard.readText === 'function') {
                        return win.navigator.clipboard.readText().catch(() => '');
                    }
                    return '';
                }).then((copiedText) => {
                    const fallbackLink = `${portalBaseUrl}/${locale}/${createdProjectId}/start`;
                    const participantUrl = copiedText && copiedText.trim().length > 0 ? copiedText.trim() : fallbackLink;
                    cy.log(`Participant URL: ${participantUrl}`);
                    Cypress.env(participantLinkEnvKey, participantUrl);
                });
            }
        });

        // Logout to ensure clean state for Part 3
        openSettingsMenu();
        logout();
    });

    it('Part 2: Participant Flow - Text Typing (Public URL)', () => {
        // Retrieve env vars
        const tagName = Cypress.env(tagEnvKey);
        const thankYouContent = Cypress.env(thankYouEnvKey);
        const sessionName = `Session_${Cypress._.random(0, 10000)}`;
        registerExceptionHandling();

        resolveParticipantUrl().then((link) => {
            cy.log(`Opening participant portal: ${link}`);
            cy.visit(link);
        });


        clickThroughOnboardingUntilCheckbox();

        agreeToPrivacyPolicy();
        clickThroughOnboardingUntilMicrophone();

        cy.log('Step 4: Microphone check (skipping for text mode)');
        // Skip microphone check if present
        cy.get('body').then(($body) => {
            if ($body.find('[data-testid="portal-onboarding-mic-skip-button"]').length > 0) {
                cy.get('[data-testid="portal-onboarding-mic-skip-button"]')
                    .first()
                    .should('be.visible')
                    .click({ force: true });
            }
        });

        // Wait for name input
        typeSessionName(sessionName);

        // Tag selection
        if (tagName) {
            verifyAndSelectTag(tagName);
        } else {
            cy.log('Tag name not found in env, selecting first available tag');
            verifyAndSelectTag();
        }

        submitSessionForm();

        cy.log('Step 6: Switch to Text Mode');
        switchToTextMode();

        cy.log('Step 7: Type and Submit Text');
        const textContent = 'This is a test response typed into the participant portal.';
        typePortalText(textContent);
        submitText();

        cy.log('Step 8: Finish Conversation');
        finishTextMode();
        confirmFinishText();

        cy.wait(2000);

        cy.log('Step 9: Verify Thank You Content');
        if (thankYouContent) {
            cy.get('[data-testid="portal-finish-custom-message"]').contains(thankYouContent).should('be.visible');
        } else {
            cy.log('Thank you content not found in env, skipping verification');
        }

        cy.log('Step 10: Email Notification');
        cy.get('body').then(($body) => {
            if ($body.find('[data-testid="portal-finish-email-input"]').length > 0) {
                enterNotificationEmail('test@example.com');
                submitEmailNotification();
                cy.wait(2000);
            } else {
                cy.log('Email input not found, skipping email notification');
            }
        });
    });

    it('deletes the project and logs out', () => {
        registerExceptionHandling();
        loginToApp();

        resolveProjectId().then((id) => {
            cy.visit(buildDashboardProjectUrl(id, 'overview'));
            deleteProject(id);
            Cypress.env(projectIdEnvKey, null);
            Cypress.env(localeEnvKey, null);
            Cypress.env(participantLinkEnvKey, null);
            Cypress.env(tagEnvKey, null);
            Cypress.env(thankYouEnvKey, null);
        });

        openSettingsMenu();
        logout();
    });

});
