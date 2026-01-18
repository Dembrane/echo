export const createProject = () => {
    cy.log('Creating New Project');

    // 1. Click Create Button
    // Selector based on browser finding: Button with "Create" text.
    // Robust XPath: //button[descendant::*[contains(text(), "Create")]]
    cy.xpath('//button[descendant::*[contains(text(), "Create")]]').should('be.visible').click();

    // 2. Wait for Project Creation (Automatic Navigation)
    // User explicitly requested 5-10 second wait
    cy.wait(8000);

    // 3. Verify Navigation to Project Overview
    // The URL pattern is /projects/<uuid>/overview
    cy.url().should('include', '/projects/');
    cy.url().should('include', '/overview');

    // 4. Capture Project ID and Store it
    cy.url().then((url) => {
        const parts = url.split('/');
        // Assuming url structure '.../projects/<id>/overview'
        // parts array would have 'projects' then <id> then 'overview'
        const projectIndex = parts.indexOf('projects');
        if (projectIndex !== -1 && parts[projectIndex + 1]) {
            const projectId = parts[projectIndex + 1];
            cy.log('Captured Project ID:', projectId);

            // Store in a fixture file for future deletion tests
            // We read existing or create new array
            const filePath = 'fixtures/createdProjects.json';
            cy.task('log', `Project Created: ${projectId}`); // Log to console if task supported, or just file

            cy.readFile(filePath).then((projects) => {
                if (!projects) projects = [];
                projects.push({
                    id: projectId,
                    name: 'New Project', // Default name on creation
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

    // 1. Verify "Edit Project" section -> "Name" input value
    // XPath: find input following the "Name" label or header.
    // Based on user image/browser: it's under "Edit Project" section.
    // We can look for the input that has value "New Project" initially.
    cy.xpath(`//input[@value="${expectedName}"]`).should('be.visible');
};

export const navigateToHome = () => {
    cy.log('Navigating Back to Home');

    // Click Home Icon in Breadcrumb
    // Selector matching browser finding: a[href*="/projects"] inside breadcrumbs works, 
    // or specifically the Home icon.
    // Browser used: a.mantine-Breadcrumbs-breadcrumb[href='/en-US/projects']
    // Let's use a robust XPath for the home icon or breadcrumb link "Projects" or "Home"
    // The image showed a Home Icon.
    // XPath: Target the visible breadcrumb on desktop (hidden on mobile vs block on md)
    // The browser check confirmed the visible one is inside <div class="hidden md:block">
    cy.xpath('//div[contains(@class, "md:block")]//a[contains(@class, "mantine-Breadcrumbs-breadcrumb") and contains(@href, "/projects")]')
        .should('be.visible')
        .click();

    // Verify we are back on the list page
    cy.url().should('match', /\/projects$/);
    cy.wait(2000); // Stability wait after navigation
};

export const deleteProject = (projectId) => {
    cy.log(`Deleting Project: ${projectId}`);

    // 1. Navigate to Project Settings
    // The tab is likely named "Project Settings".
    // Browser finding: //button[contains(., "Project Settings")]
    cy.xpath('//button[contains(descendant-or-self::text(), "Project Settings")]').should('be.visible').click();
    cy.wait(2000); // Wait for settings panel to load

    // 2. Click "Delete Project" button
    // It's the red button at the bottom.
    // Selector: //button[contains(., "Delete Project")]
    cy.xpath('//button[contains(descendant-or-self::text(), "Delete Project")]').scrollIntoView().should('be.visible').click();
    cy.wait(1000); // Wait for modal animation

    // 3. Confirm Deletion in Modal
    // The modal is appended to the end of the DOM. 
    // We target the *last* visible button with "Delete Project" text.
    // Previous role="dialog" check failed, and the browser subagent confirmed "last button" works.
    cy.xpath('(//button[contains(descendant-or-self::text(), "Delete Project")])[last()]').should('be.visible').click();

    // 4. Wait for Deletion and Redirect
    cy.wait(5000); // Allow time for API and Redirect

    // 5. Verify Redirect to Projects Dashboard
    cy.url().should('match', /\/projects$/);

    // 6. Verify Project ID is NOT present in the list
    // Check that no link contains the project ID
    cy.xpath(`//a[contains(@href, "${projectId}")]`).should('not.exist');

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

export const updateProjectName = (newName) => {
    cy.log(`Updating Project Name to: ${newName}`);

    // 1. Ensure we are on Project Settings (Click tab if needed)
    // Assuming we are already on the specific project page/overview
    cy.xpath('//button[contains(descendant-or-self::text(), "Project Settings")]').should('be.visible').click();
    cy.wait(1000);

    // 2. Find Name Input
    // Using a robust selector: Find element with text "Name" (not input) and get following input.
    cy.xpath('//*[contains(text(), "Name") and not(self::input) and not(self::script)]/following::input[1]')
        .first()
        .should('be.visible')
        .clear()
        .type(newName)
        .blur(); // Blur to trigger potential auto-save

    // 3. Handle Auto-Save
    // The UI indicates "Last saved...", implying auto-save.
    cy.wait(3000); // Wait for auto-save to complete

    // Verify "saved" indication exists (case insensitive)
    cy.xpath('//*[contains(translate(text(), "SAVED", "saved"), "saved")]').should('exist');
};
