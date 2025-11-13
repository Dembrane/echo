# Server: Adding Dependencies

We use `uv` to manage our dependencies.

From [Basics of uv](https://docs.astral.sh/uv/):

Example
Add the latest version of a dependency that is compatible with the configured Python version:
$ uv add flask
Added flask>=3.0.1 as regular dependency

Add a dependency but add an optional extra feature:
$ uv add flask[dotenv]
Added flask[dotenv]>=3.0.1 as regular dependency

Add a git dependency:
$ uv add flask --git https://github.com/pallets/flask
Added flask @ git+https://github.com/pallets/flask as regular dependency

Add a local dependency:
$ uv add packagename --path path/to/packagename
Added packagename @ file:///path/to/packagename as regular dependency

