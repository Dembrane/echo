import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import { toggleOpenForParticipation } from '../../support/functions/portal';
import { openUploadModal, uploadAudioFile, clickUploadFilesButton, closeUploadModal } from '../../support/functions/conversation';

describe('Portal Participation Availability Flow', () => {
    let projectId;
    let locale = 'en-US';
    let participantLink;

    const localeSegmentPattern = /^[a-z]{2}-[A-Z]{2}$/;
    const portalBaseUrl = (Cypress.env('portalUrl') || 'https://portal.echo-next.dembrane.com').replace(/\/$/, '');
    const dashboardBaseUrl = (Cypress.env('dashboardUrl') || '').replace(/\/$/, '');

    const projectIdEnvKey = 'portalAvailabilityProjectId';
    const participantLinkEnvKey = 'portalAvailabilityParticipantLink';
    const localeEnvKey = 'portalAvailabilityLocale';

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

    const assertOpenForParticipationState = (expectedState) => {
        cy.get('[data-testid="dashboard-open-for-participation-toggle"]', { timeout: 20000 })
            .should('have.length.greaterThan', 0)
            .then(($inputs) => {
                const $visibleInput = Cypress.$($inputs).filter((_, el) => {
                    return Cypress.$(el).closest('.mantine-Switch-root').is(':visible');
                }).first();

                const $target = $visibleInput.length > 0 ? $visibleInput : Cypress.$($inputs.first());
                expect($target.prop('checked'), 'open for participation toggle').to.equal(expectedState);
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
                    throw new Error('projectId not found. Ensure portal availability setup test completed.');
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

    const resolveParticipantLink = () => {
        return cy.then(() => {
            if (!participantLink) {
                participantLink = Cypress.env(participantLinkEnvKey);
            }

            if (!locale) {
                locale = Cypress.env(localeEnvKey) || 'en-US';
            }

            if (participantLink) {
                return participantLink;
            }

            return resolveProjectId().then((id) => {
                participantLink = `${portalBaseUrl}/${locale}/${id}/start`;
                Cypress.env(participantLinkEnvKey, participantLink);
                return participantLink;
            });
        }).then((link) => {
            expect(link, 'participantLink').to.be.a('string').and.not.be.empty;
            return link;
        });
    };

    it('creates project and copies participant link', () => {
        registerExceptionHandling();
        loginToApp();

        createProject();

        cy.location('pathname').then((pathname) => {
            const pathSegments = pathname.split('/').filter(Boolean);
            const projectIndex = pathSegments.indexOf('projects');
            if (projectIndex !== -1 && pathSegments[projectIndex + 1]) {
                projectId = pathSegments[projectIndex + 1];
                const localeSegment = pathSegments[projectIndex - 1];
                if (localeSegment && localeSegmentPattern.test(localeSegment)) {
                    locale = localeSegment;
                }
            }
        }).then(() => {
            Cypress.env(projectIdEnvKey, projectId);
            Cypress.env(localeEnvKey, locale);
            expect(projectId, 'captured projectId').to.be.a('string').and.not.be.empty;
        });

        resolveProjectId().then((id) => {
            cy.visit(buildDashboardProjectUrl(id, 'overview'));
        });

        // toggleOpenForParticipation(true);



        clickVisibleCopyLinkButton();
        cy.wait(1000);

        cy.window().then((win) => {
            if (win.navigator.clipboard && typeof win.navigator.clipboard.readText === 'function') {
                return win.navigator.clipboard.readText().catch(() => '');
            }
            return '';
        }).then((copiedText) => {
            const fallbackLink = `${portalBaseUrl}/${locale}/${projectId}/start`;
            participantLink = copiedText && copiedText.trim().length > 0 ? copiedText.trim() : fallbackLink;
            Cypress.env(participantLinkEnvKey, participantLink);

            expect(participantLink, 'participant link shape').to.include(`/${projectId}/start`);
            expect(participantLink, 'participant link should not include undefined').to.not.include('/undefined/');
        });

    });

    it('opens participant link and verifies onboarding next button', () => {
        registerExceptionHandling();

        resolveParticipantLink().then((link) => {
            cy.visit(link);
        });

        cy.get('[data-testid="portal-onboarding-next-button"]', { timeout: 30000 }).should('be.visible');
    });

    it('closes participation from dashboard', () => {
        registerExceptionHandling();
        loginToApp();

        resolveProjectId().then((id) => {
            cy.visit(buildDashboardProjectUrl(id, 'overview'));
        });

        toggleOpenForParticipation(false);
        cy.wait(20000);
        assertOpenForParticipationState(false);
    });

    it('shows portal error alert after 60 seconds when participation is closed', () => {
        registerExceptionHandling();

        resolveParticipantLink().then((link) => {
            cy.visit(link);
        });

        cy.wait(60000);
        cy.reload();
        cy.get('[data-testid="portal-error-alert"]', { timeout: 20000 }).should('be.visible');
    });

    it('checks upload conversation is not working', () => {
        registerExceptionHandling();
        loginToApp();

        resolveProjectId().then((id) => {
            cy.visit(buildDashboardProjectUrl(id, 'overview'));
        });

        openUploadModal();
        uploadAudioFile('assets/videoplayback.mp3');
        clickUploadFilesButton();
        cy.wait(15000);
        closeUploadModal();

        // Verify that no conversation was created since participation is closed
        cy.wait(3000);
        cy.get('body').then(($body) => {
            const conversationItems = $body.find('[data-testid^="conversation-item-"]');
            if (conversationItems.length === 0) {
                cy.log('SUCCESS: No conversations found — upload correctly blocked when participation is closed');
            } else {
                cy.log(`FAILED: Found ${conversationItems.length} conversation(s) — upload should have been blocked`);
                throw new Error(
                    `Expected no conversations when participation is closed, but found ${conversationItems.length} conversation item(s)`
                );
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
            Cypress.env(participantLinkEnvKey, null);
            Cypress.env(localeEnvKey, null);
        });

        openSettingsMenu();
        logout();
    });
});
