from logging import basicConfig, getLogger
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from copilotkit import CopilotKitRemoteEndpoint, LangGraphAgent
from copilotkit.integrations.fastapi import handler as copilotkit_handler

from agent import create_agent_graph
from auth import extract_bearer_token
from settings import get_settings

load_dotenv()
basicConfig(level="INFO")
logger = getLogger("echo-agent")
settings = get_settings()

app = FastAPI(
    title="Echo Agent Service",
    description="Isolated CopilotKit runtime for Agentic Chat",
    version="0.1.0",
)

cors_origins = [origin.strip() for origin in settings.agent_cors_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "echo-agent"}


@app.api_route("/copilotkit/{project_id}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
@app.api_route("/copilotkit/{project_id}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
async def copilotkit_endpoint(request: Request, project_id: str, path: Optional[str] = None) -> Any:
    logger.info(
        "copilotkit request: method=%s project_id=%s path=%s",
        request.method,
        project_id,
        path,
    )
    bearer_token = extract_bearer_token(request)

    # CopilotKit fastapi handler routes by request.scope["path_params"]["path"].
    # Rewrite root chat posts to default agent execution path.
    if request.method == "POST" and (path is None or path == ""):
        path = "agent/default"

    request.scope.setdefault("path_params", {})
    request.scope["path_params"]["path"] = path or ""

    agent = LangGraphAgent(
        name="default",
        description="Echo Agentic Chat default agent",
        graph=create_agent_graph(project_id=project_id, bearer_token=bearer_token),
    )
    # CopilotKit currently rejects LangGraphAgent only for literal list inputs.
    # Supplying a callable preserves expected runtime behavior in this SDK version.
    endpoint = CopilotKitRemoteEndpoint(agents=lambda _context: [agent])
    return await copilotkit_handler(request, endpoint)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
