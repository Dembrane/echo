# legacy

What only exists because of the previous stack (the Python API and Directus). Nothing here
ships in an image.

- `parity/`: runs the previous API and this one side by side on the same seeded database and
  compares their answers. It also builds the database template (`parity_template_platform`)
  that the integration tests marked with `TEST_PARITY_ADMIN_URL` copy for each run.
- `ops/`: the scripts written for moving production data to a new home: dumps, file sync,
  verification and the archive of the tables the contract migration drops.

Both go once production runs this platform and those tests seed their own database.
