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
    setReportPublishState,
    waitForPublicReportPublished
} from '../../support/functions/report';

describe('Publish Report Flow', () => {
    let projectId;
    let locale = 'en-US';

    const portalBaseUrl = (Cypress.env('portalUrl') || 'https://portal.echo-next.dembrane.com').replace(/\/$/, '');
    const dashboardBaseUrl = (Cypress.env('dashboardUrl') || '').replace(/\/$/, '');

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
        if (dashboardBaseUrl) {
            cy.visit(`${dashboardBaseUrl}/projects/${id}/report`);
            return;
        }

        cy.visit(`/${locale}/projects/${id}/report`);
    };

    const openPublicReportPage = (id) => {
        cy.visit(`${portalBaseUrl}/${locale}/${id}/report`);
    };

    it('creates a project and generates a report draft', () => {
        registerReportFlowExceptionHandling();
        loginToApp();

        cy.log('Step 1: Creating new project');
        createProject();

        cy.url().then((url) => {
            const parts = url.split('/');
            const projectIndex = parts.indexOf('projects');
            if (projectIndex !== -1 && parts[projectIndex + 1]) {
                projectId = parts[projectIndex + 1];
                if (parts[projectIndex - 1]) {
                    locale = parts[projectIndex - 1];
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

    it('shows report as unavailable on public URL before publish', () => {
        registerReportFlowExceptionHandling();

        resolveProjectId().then((id) => {
            openPublicReportPage(id);
        });

        cy.get('[data-testid="public-report-not-available"]', { timeout: 20000 }).should('be.visible');
        cy.get('[data-testid="public-report-view"]').should('not.exist');
    });

    it('publishes the report from dashboard', () => {
        registerReportFlowExceptionHandling();
        loginToApp();

        resolveProjectId().then((id) => {
            openDashboardReportPage(id);
        });

        setReportPublishState(true);
    });

    it('shows published report on public URL after publish', () => {
        registerReportFlowExceptionHandling();

        resolveProjectId().then((id) => {
            openPublicReportPage(id);
        });

        // waitForPublicReportPublished();

        cy.get('[data-testid="public-report-not-available"]').should('not.exist');
        cy.get('[data-testid="public-report-view"]', { timeout: 20000 }).should('be.visible');
    });

    it('deletes the project and logs out', () => {
        registerReportFlowExceptionHandling();
        loginToApp();

        resolveProjectId().then((id) => {
            if (dashboardBaseUrl) {
                cy.visit(`${dashboardBaseUrl}/projects/${id}/overview`);
            } else {
                cy.visit(`/${locale}/projects/${id}/overview`);
            }
            deleteProject(id);
            Cypress.env('publishReportProjectId', null);
        });

        openSettingsMenu();
        logout();
    });
});
