# A dependency migration validated by construction, not execution

**Rule: validate a dependency or SDK migration by running the real path end to end and
asserting on the output. Imports resolving and objects constructing prove nothing. If
the change is a protocol or serving-interface change, the only honest test is a real
request.**

## What happened

The agent's `copilotkit` dependency was upgraded from 0.1.78 to 0.1.94 in
`feat(agent): upgrade copilotkit to 0.1.94 (AG-UI migration)` (79afc324, PR #754).

Validation consisted of probing the new API surface and confirming that
`LangGraphAGUIAgent` imported and constructed cleanly. On that basis the migration was
judged small and shipped. It failed at runtime with
`AttributeError: no attribute 'execute'`, because the serving and execution interface
had changed, not the constructor. Two broken deploys to Echo Next followed before the
upgrade was reverted in
`revert: copilotkit 0.1.94 AG-UI upgrade (#754) — incompatible protocol` (28558302,
PR #756). `echo/agent/uv.lock` still resolves `copilotkit` to 0.1.78; the
`pyproject.toml` constraint is only `>=0.1.77`, so the lockfile is what holds the line.
Do not regenerate it casually.

The same pattern had already appeared once that day, on the agent image: it imported
fine locally, and the container path bug and dependency-lock problems only showed up on
a real boot and a real request.

## Mechanism

Construction and execution are separate surfaces, and a major version bump can leave
one intact while replacing the other. Constructing an object exercises `__init__`
signatures and import graphs. It does not exercise the methods a server calls, the
event shapes a client parses, or the wire protocol between them. 0.1.94 was an AG-UI
protocol migration spanning several layers, so the parts that changed were exactly the
parts a construction check cannot reach.

The check was not weak by accident. It was reassuring, quick, and produced a green
result, which is how it substituted for the harder test.

## The rule in practice

Before merging a dependency bump or a protocol change:

1. Run the real entrypoint. Build the graph against a stub model and stream an actual
   request through the endpoint.
2. Assert on the output: event types and ordering, status codes, the response body.
   Not "no exception raised".
3. For anything that ships in a container, build and boot the container and send it a
   request. Dockerfile, lockfile, and path problems are invisible to a host-side
   import.
4. Keep the check. Turn it into a regression test so the next bump inherits it rather
   than repeating the reasoning.

The useful question for sizing a migration is not "did the API surface change" but
"which layers does this touch". A change across serving, protocol, client, and event
schema is not a version bump regardless of how the version number reads.

## See also

- [dramatiq-actor-event-loops.md](dramatiq-actor-event-loops.md): the same lesson from
  the worker side, where the hang in PR #718 was caught by a real deploy and by no test
- [../agentic-chat-design.md](../agentic-chat-design.md)
