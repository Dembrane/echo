from logging import getLogger
from typing import Any

from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode

from settings import get_settings

logger = getLogger("agent")

SYSTEM_PROMPT = """You are the Echo Agentic Chat assistant.

You run in an isolated backend service and should proactively use tools to gather
context before answering.

Current scaffold note: tool surface is intentionally minimal. Expand tools in
server-approved increments with strict auth passthrough.
"""


def _build_llm() -> ChatGoogleGenerativeAI:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise ValueError("GEMINI_API_KEY is required")

    return ChatGoogleGenerativeAI(
        model=settings.llm_model,
        google_api_key=settings.gemini_api_key,
    )


def create_agent_graph(project_id: str):
    @tool
    async def get_project_scope() -> dict[str, Any]:
        """Return the current project scope for this agent run."""
        return {"project_id": project_id}

    tools = [get_project_scope]
    llm = _build_llm()
    llm_with_tools = llm.bind_tools(tools)

    def should_continue(state: dict) -> str:
        messages = state.get("messages", [])
        if not messages:
            return END
        last_message = messages[-1]
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "tools"
        return END

    async def call_model(state: dict) -> dict:
        messages = state.get("messages", [])
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=SYSTEM_PROMPT)] + messages
        response = await llm_with_tools.ainvoke(messages)
        return {"messages": messages + [response]}

    workflow = StateGraph(dict)
    workflow.add_node("agent", call_model)
    workflow.add_node("tools", ToolNode(tools))

    workflow.set_entry_point("agent")
    workflow.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    workflow.add_edge("tools", "agent")
    return workflow.compile()
