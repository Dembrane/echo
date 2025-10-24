# Server: Adding Dependencies

We use `uv` to manage the server's Python dependencies.

`uv` keeps the project configuration in `pyproject.toml` and records exact
versions in `uv.lock`. When you add or update packages with `uv`, both files
are updated automatically and the project virtual environment is kept in sync.

## Adding packages

Add the latest version of a dependency that is compatible with the configured
Python version:

```bash
uv add fastapi
```

Add a dependency with optional extras:

```bash
uv add "fastapi[standard]"
```

Install from a Git repository:

```bash
uv add fastapi --git https://github.com/pallets/flask
```

Add a local path dependency:

```bash
uv add my-package --path ../my-package
```

For development-only packages (linters, test runners, etc.), use a dependency
group:

```bash
uv add --group dev ruff pytest
uv sync --group dev
```

## Working with the environment

- `uv sync` ensures the `.venv` matches the lockfile. Include
  `--group dev` to install dev-only dependencies.
- `uv run <command>` executes a tool inside the project environment. For
  example `uv run pytest` or `uv run ruff check .`.
- `uv export --format requirements-txt > requirements.lock` refreshes the
  legacy `requirements.lock` file if tooling still depends on it.

Refer to the [uv documentation](https://docs.astral.sh/uv) for more options
and detailed explanations of every flag.
