"""Read primitives with one implementation and two front doors.

The in-app assistant (`api/agentic.py`) and the agent access surface
(`agent_access/tools.py`, behind MCP and REST) both need to find, grep and
read conversations, and to find projects. Each primitive here resolves
access through the v2 resolvers the dashboard uses, applies the
locked/over-cap scrub, and returns a small typed result that the front door
reshapes into its own contract. A front door never queries
`conversation_chunk` itself.
"""
