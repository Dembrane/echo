- prod worker cpu using watch
- in the regular worker removed watch
- 8001? let's use devcontainers
- many local imports python
- pr size
- dockerfile update


- (feature) new "Dembrane 25-09" transcription provider used for all new transcription (AssemblyAI + Gemini)
- (feature) add pii redaction option when retranscription
- (feature) add clone project functionality (only metadata) + tests
- (bug) fix premature calling of "finish conversation" (duration bug)
- dev stuff:
    - use vertex ai instead of gemini api
    - remove grid view
    - add biome for frontend linting and formatting (eslint + prettier was breaking my pc lol)
    - refactor conversation transcript into maintainable components