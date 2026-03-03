/**
 * Publish Report Flow Test Suite
 *
 * Split into single-origin tests so it runs in Chromium/Firefox/WebKit
 * without relying on cy.origin().
 */

import { loginToApp, logout } from '../../support/functions/login';
import { createProject, deleteProject } from '../../support/functions/project';
import { openSettingsMenu } from '../../support/functions/settings';
import {
    openUploadModal,
    uploadAudioFile,
    clickUploadFilesButton,
    closeUploadModal
} from '../../support/functions/conversation';
import {
    registerReportFlowExceptionHandling,
    setReportPublishState
} from '../../support/functions/report';

describe('Publish Report Flow', () => {
    let projectId;
    let locale = 'en-US';
    const localeSegmentPattern = /^[a-z]{2}-[A-Z]{2}$/;

    const portalBaseUrl = (Cypress.env('portalUrl') || 'https://portal.echo-next.dembrane.com').replace(/\/$/, '');
    const dashboardBaseUrl = (Cypress.env('dashboardUrl') || '').replace(/\/$/, '');
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

    const resolveProjectId = () => {
        return cy.then(() => {
            if (!projectId) {
                projectId = Cypress.env('publishReportProjectId');
            }

            if (projectId) {
                return projectId;
            }

            return cy.readFile('fixtures/createdProjects.json', { log: false }).then((projects) => {
                const lastProject = Array.isArray(projects) ? projects[projects.length - 1] : null;
                if (!lastProject || !lastProject.id) {
                    throw new Error('projectId not found. Ensure report setup test completed.');
                }
                projectId = lastProject.id;
                Cypress.env('publishReportProjectId', projectId);
                return projectId;
            });
        }).then((id) => {
            expect(id, 'projectId').to.be.a('string').and.not.be.empty;
            return id;
        });
    };

    const openDashboardReportPage = (id) => {
        cy.visit(buildDashboardProjectUrl(id, 'report'));
    };

    const openPublicReportPage = (id) => {
        cy.visit(`${portalBaseUrl}/${locale}/${id}/report`);
    };

    it('creates a project and generates a report draft', () => {
        registerReportFlowExceptionHandling();
        loginToApp();

        cy.log('Step 1: Creating new project');
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
                Cypress.env('publishReportProjectId', projectId);
                cy.log('Captured Project ID:', projectId);
            }
        });

        cy.log('Step 2: Uploading audio');
        openUploadModal();
        uploadAudioFile('assets/videoplayback.mp3');
        clickUploadFilesButton();
        cy.wait(20000);
        closeUploadModal();

        cy.log('Step 3: Creating report');
        cy.get('[data-testid="sidebar-report-button"]').filter(':visible').first().click();
        cy.get('section[role="dialog"]').should('be.visible');
        cy.get('[data-testid="report-create-button"]').filter(':visible').first().click();
        cy.wait(30000);

        cy.get('[data-testid="sidebar-report-button"]').filter(':visible').first().click();
        cy.get('[data-testid="report-renderer-container"]', { timeout: 20000 }).should('be.visible');
    });



    it('print report', () => {
        registerReportFlowExceptionHandling();
        loginToApp();

        resolveProjectId().then((id) => {
            openDashboardReportPage(id);
            setReportPublishState(true);
            cy.get('[data-testid="report-renderer-container"]', { timeout: 20000 }).should('be.visible');
            let expectedPrintUrl;
            cy.location('pathname').then((pathname) => {
                const localeSegment = pathname
                    .split('/')
                    .filter(Boolean)
                    .find((segment) => localeSegmentPattern.test(segment));
                if (localeSegment) {
                    locale = localeSegment;
                }
                expectedPrintUrl = `${portalBaseUrl}/${locale}/${id}/report?print=true`;
            });

            cy.window().then((win) => {
                cy.stub(win, 'open').as('windowOpen');
            });

            cy.get('[data-testid="report-print-button"]').filter(':visible').first().click();

            cy.get('@windowOpen').should('have.been.calledOnce');
            cy.get('@windowOpen').then((openStub) => {
                const [openedUrl, target] = openStub.getCall(0).args;
                expect(target, 'window.open target').to.equal('_blank');
                expect(openedUrl, 'print URL').to.equal(expectedPrintUrl);
            });
        });

    });



    it('deletes the project and logs out', () => {
        registerReportFlowExceptionHandling();
        loginToApp();

        resolveProjectId().then((id) => {
            cy.visit(buildDashboardProjectUrl(id, 'overview'));
            deleteProject(id);
            Cypress.env('publishReportProjectId', null);
        });

        openSettingsMenu();
        logout();
    });
});
