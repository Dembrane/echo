import os
from logging import getLogger

from fastapi import Request, APIRouter, HTTPException
from litellm import completion
from pydantic import BaseModel
from lightrag.lightrag import QueryParam
from lightrag.kg.postgres_impl import PostgreSQLDB

from dembrane.audio_lightrag.utils.lightrag_utils import (
    upsert_transcript,
    fetch_query_transcript,
)

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])

postgres_config = {
    "host": os.environ["POSTGRES_HOST"],
    "port": os.environ["POSTGRES_PORT"],
    "user": os.environ["POSTGRES_USER"],
    "password": os.environ["POSTGRES_PASSWORD"],
    "database": os.environ["POSTGRES_DATABASE"],
}

postgres_db = PostgreSQLDB(config=postgres_config)

class TranscriptRequest(BaseModel):
    system_prompt: str | None = None
    transcript: str
    language: str | None = None


class TranscriptResponse(BaseModel):
    summary: str


class InsertRequest(BaseModel):
    content: str | list[str]
    transcripts: list[str]
    id: str | list[str] | None = None

class InsertResponse(BaseModel):
    status: str
    result: dict


class QueryRequest(BaseModel):
    query: str
    id: str | list[str] | None = None

class QueryResponse(BaseModel):
    status: str
    result: str
    transcripts: list[str]


@StatelessRouter.post("/summarize")
async def summarize_conversation_transcript(
    # auth: DependencyDirectusSession,
    body: TranscriptRequest,
) -> TranscriptResponse:
    # Use the provided transcript and system prompt (if any) for processing
    system_prompt = body.system_prompt
    transcript = body.transcript

    # Generate a summary from the transcript (placeholder logic)
    summary = generate_summary(transcript, system_prompt, body.language)

    # Return the full transcript as a single string
    return TranscriptResponse(summary=summary)


def generate_summary(transcript: str, system_prompt: str | None, language: str | None) -> str:
    """
    Generate a summary of the transcript using LangChain and a custom API endpoint.

    Args:
        transcript (str): The conversation transcript to summarize.
        system_prompt (str | None): Additional context or instructions for the summary.

    Returns:
        str: The generated summary.
    """
    # Prepare the prompt template
    base_prompt = f"You are a helpful assistant. Please provide a summary of the following transcript. Only return the summary itself, do not include any other text. Focus on the most interesting/surprise invoking points of the text. Ignore any personal information. The language of the summary must be in {language}."
    if system_prompt:
        base_prompt += f"\nContext (ignore if None): {system_prompt}"

    final_prompt = f"{base_prompt}\n\n{transcript}"

    # Call the model over the provided API endpoint
    response = completion(
        # model="ollama/llama3.1:8b",
        # api_base="https://llm-demo.ai-hackathon.haven.vng.cloud",
        model="anthropic/claude-3-5-sonnet-20240620",
        messages=[
            {
                "content": final_prompt,
                "role": "user",
            }
        ],
    )

    response_content = response["choices"][0]["message"]["content"]

    return response_content


@StatelessRouter.post("/rag/insert")
async def insert_item(request: Request, payload: InsertRequest) -> InsertResponse:
    rag = request.app.state.rag
    if rag is None:
        raise HTTPException(status_code=500, detail="RAG object not initialized")
    try:
        # Insert the content and create a default result dictionary
        # rag.insert("TEXT1", ids=["ID_FOR_TEXT1"])
        rag.insert(payload.content, ids=[payload.id])
        await postgres_db.initdb()
        for transcript in payload.transcripts:
            await upsert_transcript(postgres_db, 
                                document_id = str(payload.id), 
                                content = transcript)
        result = {"status": "inserted", "content": payload.content}
        return InsertResponse(status="success", result=result)
    except Exception as e:
        logger.exception("Insert operation failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


@StatelessRouter.post("/rag/query")
async def query_item(request: Request, payload: QueryRequest) -> QueryResponse:
    rag = request.app.state.rag
    if rag is None:
        raise HTTPException(status_code=500, detail="RAG object not initialized")
    try:
        result = rag.query(payload.query, param=QueryParam(mode="mix"))
        print(f'*********{result}*********')
        await postgres_db.initdb()
        transcripts = await fetch_query_transcript(postgres_db, 
                                            str(result), 
                                            ids = payload.id if payload.id else None)
        # Extract just the content from the transcripts
        transcript_contents = [t['content'] for t in transcripts] if isinstance(transcripts, list) else [transcripts['content']] # type: ignore
        return QueryResponse(status="success", result=result, transcripts=transcript_contents)
    except Exception as e:
        logger.exception("Query operation failed")
        raise HTTPException(status_code=500, detail=str(e)) from e
