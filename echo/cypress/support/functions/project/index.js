export const createProject = () => {
    cy.log('Creating New Project');

    // 1. Click Create Button using data-testid
    cy.get('[data-testid="project-home-create-button"]').should('be.visible').click();

    // 2. Wait for Project Creation (Automatic Navigation)
    cy.wait(8000);

    // 3. Verify Navigation to Project Overview
    cy.url().should('include', '/projects/');
    cy.url().should('include', '/overview');

    // 4. Capture Project ID and Store it
    cy.url().then((url) => {
        const parts = url.split('/');
        const projectIndex = parts.indexOf('projects');
        if (projectIndex !== -1 && parts[projectIndex + 1]) {
            const projectId = parts[projectIndex + 1];
            cy.log('Captured Project ID:', projectId);

            const filePath = 'fixtures/createdProjects.json';
            cy.task('log', `Project Created: ${projectId}`);

            cy.readFile(filePath).then((projects) => {
                if (!projects) projects = [];
                projects.push({
                    id: projectId,
                    name: 'New Project',
                    createdAt: new Date().toISOString()
                });
                console.log(projects);
                cy.writeFile(filePath, projects);
            });
        }
    });
};

export const verifyProjectPage = (expectedName = 'New Project') => {
    cy.log('Verifying Project Page');

    // Verify project name input has expected value using data-testid
    cy.get('[data-testid="project-settings-name-input"]')
        .should('be.visible')
        .should('have.value', expectedName);
};

export const navigateToHome = () => {
    cy.log('Navigating Back to Home');

    cy.window().then((win) => {
        const isMobile = win.innerWidth < 768;

        if (isMobile) {
            // On mobile, use direct navigation
            cy.url().then((currentUrl) => {
                const locale = currentUrl.includes('/en-US/') ? 'en-US' :
                    currentUrl.includes('/nl-NL/') ? 'nl-NL' : 'en-US';
                cy.visit(`/${locale}/projects`);
            });
        } else {
            // On desktop, click the home breadcrumb using data-testid (filter visible for mobile/desktop duplicates)
            cy.get('[data-testid="project-breadcrumb-home"]').filter(':visible').first().click();
        }

        // Verify we are back on the list page
        cy.url().should('match', /\/projects$/);
        cy.wait(2000);
    });
};

export const deleteProject = (projectId) => {
    cy.log(`Deleting Project: ${projectId}`);

    // 1. Navigate to Project Settings using data-testid
    cy.get('[data-testid="project-overview-tab-overview"]').should('be.visible').click();
    cy.wait(5000);

    // 2. Click "Delete Project" button using data-testid
    cy.get('[data-testid="project-actions-delete-button"]').scrollIntoView().should('be.visible').click();
    cy.wait(5000);
    // 3. Wait for modal to appear and confirm deletion
    cy.get('[data-testid="project-delete-confirm-button"]', { timeout: 10000 })
        .should('be.visible')
        .click();

    // 4. Wait for Deletion and Redirect
    cy.wait(5000);

    // 5. Verify Redirect to Projects Dashboard
    cy.url().should('match', /\/projects$/);

    // 6. Verify Project ID is NOT present in the list
    cy.get(`a[href*="${projectId}"]`).should('not.exist');

    // 7. Remove from JSON fixture
    const filePath = 'fixtures/createdProjects.json';
    cy.readFile(filePath).then((projects) => {
        if (projects && projects.length > 0) {
            const updatedProjects = projects.filter(p => p.id !== projectId);
            cy.writeFile(filePath, updatedProjects);
            cy.log(`Removed project ${projectId} from fixture.`);
        }
    });
};
export const deleteProjectInsideProjectSettings = (projectId) => {
    cy.log(`Deleting Project: ${projectId}`);

    // Click "Delete Project" button using data-testid
    cy.get('[data-testid="project-actions-delete-button"]').scrollIntoView().should('be.visible').click();

    // Wait for modal to appear and confirm deletion
    cy.get('[data-testid="project-delete-confirm-button"]', { timeout: 10000 })
        .should('be.visible')
        .click();

    // Wait for Deletion and Redirect
    cy.wait(5000);

    // Verify Redirect to Projects Dashboard
    cy.url().should('match', /\/projects$/);

    // Verify Project ID is NOT present in the list
    cy.get(`a[href*="${projectId}"]`).should('not.exist');

    // Remove from JSON fixture
    const filePath = 'fixtures/createdProjects.json';
    cy.readFile(filePath).then((projects) => {
        if (projects && projects.length > 0) {
            const updatedProjects = projects.filter(p => p.id !== projectId);
            cy.writeFile(filePath, updatedProjects);
            cy.log(`Removed project ${projectId} from fixture.`);
        }
    });
};

export const updateProjectName = (newName) => {
    cy.log(`Updating Project Name to: ${newName}`);

    // 1. Ensure we are on Project Settings using data-testid
    cy.get('[data-testid="project-overview-tab-overview"]').should('be.visible').click();
    cy.wait(1000);

    // 2. Find and update Name Input using data-testid
    cy.get('[data-testid="project-settings-name-input"]')
        .should('be.visible')
        .clear()
        .type(newName)
        .blur();

    // 3. Handle Auto-Save
    cy.wait(3000);

    // Verify "saved" indication exists
    cy.contains(/saved/i).should('exist');
};

export const openProjectSettings = () => {
    cy.log('Opening Project Settings Tab');
    cy.get('[data-testid="project-overview-tab-overview"]').scrollIntoView().click({ force: true });
    cy.wait(1000);
};

export const exportProjectTranscripts = () => {
    cy.log('Exporting Project Transcripts');
    cy.get('[data-testid="project-export-transcripts-button"]').scrollIntoView().click({ force: true });
};
