# Server: Adding Dependencies

We use `rye` to manage our dependencies. It uses `uv` under the hood.

> [How will rye and uv coexist in the future?](https://github.com/astral-sh/rye/discussions/1164)

From [Basics of rye](https://rye.astral.sh/guide/basics/):

Example
Add the latest version of a dependency that is compatible with the configured Python version:
$ rye add flask
Added flask>=3.0.1 as regular dependency

Add a dependency but add an optional extra feature:
$ rye add flask --features dotenv
Added flask[dotenv]>=3.0.1 as regular dependency

Add a git dependency:
$ rye add flask --git https://github.com/pallets/flask
Added flask @ git+https://github.com/pallets/flask as regular dependency

Add a local dependency:
$ rye add packagename --path path/to/packagename
Added packagename @ file:///path/to/packagename as regular dependency

