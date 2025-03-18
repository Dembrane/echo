# Environment Variables Configuration (Frontend)

This document provides an overview of the environment variables used in the frontend application configuration.

> [!IMPORTANT]
> These can be set using [env files](https://vitejs.dev/guide/env-and-mode#env-files) or using the `config.ts` file in the frontend directory.

## Required Environment Variables

### VITE_API_BASE_URL

- **Description**: Base URL for the API.
- **Default Value**: `/api`

### VITE_ADMIN_BASE_URL

- **Description**: Base URL for the admin interface.
- **Default Value**: `window.location.origin`

### VITE_DIRECTUS_PUBLIC_URL

- **Description**: Base URL for the Directus instance.
- **Default Value**: `http://localhost:8055`

## Optional Environment Variables

### VITE_USE_PARTICIPANT_ROUTER

- **Description**: Enables or disables the participant router.
- **Default Value**: `false`
- **Possible Values**: `true`, `false`, `1`
- **Example**: `VITE_USE_PARTICIPANT_ROUTER=1`

### VITE_PARTICIPANT_BASE_URL

- **Description**: Base URL for the participant interface.
- **Default Value**: `window.location.origin`

### VITE_DIRECTUS_CONTENT_PUBLIC_URL

- **Description**: Base URL for the Directus content.
- **Default Value**: `https://admin-dembrane.azurewebsites.net`

### VITE_DISABLE_SENTRY

- **Description**: Disables Sentry error tracking if set to true.
- **Default Value**: `false`
- **Possible Values**: `true`, `false`, `1`
- **Example**: `VITE_DISABLE_SENTRY=1`

### VITE_BUILD_VERSION

- **Description**: Specifies the build version of the application.
- **Default Value**: `dev`
- **Example**: `VITE_BUILD_VERSION=1.0.0`

### VITE_ENABLE_AUDIO_DOWNLOAD

- **Description**: Enables audio download functionality if set to true.
- **Default Value**: `false`
- **Possible Values**: `true`, `false`, `1`
- **Example**: `VITE_ENABLE_AUDIO_DOWNLOAD=1`

## Additional Configuration

### Supported Languages

The application supports the following languages:
- English (en-US)
- Dutch (nl-NL)
- German (de-DE)
- French (fr-FR)
- Spanish (es-ES)

### Privacy Policy

The privacy policy is available at a fixed URL: [Privacy Statements](https://dembrane.notion.site/Privacy-statements-all-languages-fa97a183f9d841f7a1089079e77ffb52)

Ensure these environment variables are correctly set in your deployment environment to configure the application as needed.
