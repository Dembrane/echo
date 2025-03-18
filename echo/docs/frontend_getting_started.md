# Dembrane ECHO Frontend

Use this to run only the frontend.

For the .env settings, you may use the "development" environment variables.

## Setup

1. Install dependencies

  ```bash
  pnpm install
  ```

2. Configure the `.env` file

  ```bash
  cp .env.example .env
  ```

3. Run the development server

  ```bash
  # to run the dashboard
  pnpm dev

  # to run the participant portal (this automatically sets VITE_USE_PARTICIPANT_ROUTER=1)
  pnpm dev:participant
  ```

## Important Links

### [FAQ](./getting_started.md#faq)
### [Configuration](./frontend_configuration.md)
### [Translations](./frontend_translations.md)
