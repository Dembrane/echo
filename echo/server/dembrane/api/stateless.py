from logging import getLogger

import nest_asyncio
from fastapi import APIRouter, HTTPException
from litellm import completion
from pydantic import BaseModel
from lightrag.lightrag import QueryParam
from lightrag.kg.shared_storage import initialize_pipeline_status

from dembrane.prompts import render_prompt
from dembrane.rag_manager import RAGManager, get_rag
from dembrane.postgresdb_manager import PostgresDBManager
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.audio_lightrag.utils.lightrag_utils import (
    is_valid_uuid,
    upsert_transcript,
    fetch_query_transcript,
    delete_transcript_by_doc_id,
    delete_segment_from_directus,
    get_segment_from_project_ids,
    get_segment_from_conversation_ids,
    get_segment_from_conversation_chunk_ids,
)

nest_asyncio.apply()

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])


def generate_summary(transcript: str, language: str | None) -> str:
    """
    Generate a summary of the transcript using LangChain and a custom API endpoint.

    Args:
        transcript (str): The conversation transcript to summarize.
        language (str | None): The language of the transcript.

    Returns:
        str: The generated summary.
    """
    # Prepare the prompt template
    prompt = render_prompt(
        "generate_conversation_summary",
        language if language else "en",
        {"quote_text_joined": transcript},
    )

    # Call the model over the provided API endpoint
    response = completion(
        model="anthropic/claude-3-5-sonnet-20240620",
        messages=[
            {
                "content": prompt,
                "role": "user",
            }
        ],
    )

    response_content = response["choices"][0]["message"]["content"]

    return response_content


def validate_segment_id(echo_segment_ids: list[str] | None) -> bool:
    if echo_segment_ids is None:
        return True
    try:
        [int(id) for id in echo_segment_ids]
        return True
    except Exception as e:
        logger.exception(f"Invalid segment ID: {e}")
        return False


class InsertRequest(BaseModel):
    content: str | list[str]
    transcripts: list[str]
    echo_segment_id: str


class InsertResponse(BaseModel):
    status: str
    result: dict


@StatelessRouter.post("/rag/insert")
async def insert_item(
    payload: InsertRequest,
    session: DependencyDirectusSession,  # Needed for fake auth
) -> InsertResponse:
    session = session
    if not RAGManager.is_initialized():
        await RAGManager.initialize()
    rag = get_rag()
    await initialize_pipeline_status()
    if rag is None:
        raise HTTPException(status_code=500, detail="RAG object not initialized")
    try:
        postgres_db = await PostgresDBManager.get_initialized_db()
    except Exception as e:
        logger.exception("Failed to get initialized PostgreSQLDB for insert")
        raise HTTPException(status_code=500, detail="Database connection failed") from e
    try:
        if isinstance(payload.echo_segment_id, str):
            echo_segment_ids = [payload.echo_segment_id]
        else:
            raise HTTPException(status_code=400, detail="Invalid segment ID")

        if validate_segment_id(echo_segment_ids):
            await rag.ainsert(
                payload.content,
                ids=echo_segment_ids,
                file_paths=["SEGMENT_ID_" + x for x in echo_segment_ids],
            )
            for transcript in payload.transcripts:
                await upsert_transcript(
                    postgres_db, document_id=str(payload.echo_segment_id), content=transcript
                )
            result = {"status": "inserted", "content": payload.content}
            return InsertResponse(status="success", result=result)
        else:
            raise HTTPException(status_code=400, detail="Invalid segment ID")
    except Exception as e:
        logger.exception("Insert operation failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


class SimpleQueryRequest(BaseModel):
    query: str
    echo_segment_ids: list[str] | None = None
    get_transcripts: bool = False


class SimpleQueryResponse(BaseModel):
    status: str
    result: str
    transcripts: list[str]


@StatelessRouter.post("/rag/simple_query")
async def query_item(
    payload: SimpleQueryRequest,
    session: DependencyDirectusSession,  # Needed for fake auth
) -> SimpleQueryResponse:
    session = session
    if not RAGManager.is_initialized():
        await RAGManager.initialize()
    rag = get_rag()
    await initialize_pipeline_status()
    if rag is None:
        raise HTTPException(status_code=500, detail="RAG object not initialized")
    try:
        postgres_db = await PostgresDBManager.get_initialized_db()
    except Exception as e:
        logger.exception("Failed to get initialized PostgreSQLDB for query")
        raise HTTPException(status_code=500, detail="Database connection failed") from e
    try:
        if isinstance(payload.echo_segment_ids, list):
            echo_segment_ids = payload.echo_segment_ids
        else:
            echo_segment_ids = None

        if validate_segment_id(echo_segment_ids):
            result = rag.query(
                payload.query,
                param=QueryParam(mode="mix", ids=echo_segment_ids if echo_segment_ids else None),
            )
            if payload.get_transcripts:
                transcripts = await fetch_query_transcript(
                    postgres_db, str(result), ids=echo_segment_ids if echo_segment_ids else None
                )
                transcript_contents = (
                    [t for t in transcripts] if isinstance(transcripts, list) else []
                )
                # transcript_contents = (
                #     [t["content"] for t in transcripts]
                #     if isinstance(transcripts, list)
                #     else [transcripts["content"]]
                # )
            else:
                transcript_contents = []
            return SimpleQueryResponse(
                status="success", result=result, transcripts=transcript_contents
            )
        else:
            raise HTTPException(status_code=400, detail="Invalid segment ID")
    except Exception as e:
        logger.exception("Query operation failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


class GetLightragQueryRequest(BaseModel):
    query: str
    conversation_history: list[dict[str, str]] | None = None
    echo_segment_ids: list[str] | None = None
    echo_conversation_ids: list[str] | None = None
    echo_project_ids: list[str] | None = None
    auto_select_bool: bool = False
    get_transcripts: bool = False
    top_k: int = 60


@StatelessRouter.post("/rag/get_lightrag_prompt")
async def get_lightrag_prompt(
    payload: GetLightragQueryRequest,
    session: DependencyDirectusSession,  # Needed for fake auth
) -> str:
    session = session
    # Validate payload
    if not payload.auto_select_bool:
        if (
            payload.echo_segment_ids is None
            and payload.echo_conversation_ids is None
            and payload.echo_project_ids is None
        ):
            raise HTTPException(
                status_code=400,
                detail="At least one of echo_segment_ids, echo_conversation_ids, or echo_project_ids must be provided if auto_select_bool is False",
            )
    # Initialize database
    try:
        postgres_db = await PostgresDBManager.get_initialized_db()
    except Exception as e:
        logger.exception("Failed to get initialized PostgreSQLDB for query")
        raise HTTPException(status_code=500, detail="Database connection failed") from e

    # Get echo segment ids
    echo_segment_ids: list[int] = []
    if payload.echo_segment_ids:
        echo_segment_ids += [int(id) for id in payload.echo_segment_ids]
    if payload.echo_conversation_ids:
        conversation_segments = await get_segment_from_conversation_chunk_ids(
            postgres_db, payload.echo_conversation_ids
        )
        echo_segment_ids += conversation_segments
    if payload.echo_project_ids:
        project_segments = await get_segment_from_project_ids(postgres_db, payload.echo_project_ids)
        echo_segment_ids += project_segments
    # if payload.auto_select_bool:
    #     all_segments = await get_all_segments(postgres_db, payload.echo_conversation_ids) # type: ignore
    #     echo_segment_ids += all_segments

    # Initialize RAG
    if not RAGManager.is_initialized():
        await RAGManager.initialize()
    rag = get_rag()
    await initialize_pipeline_status()
    if rag is None:
        raise HTTPException(status_code=500, detail="RAG object not initialized")

    # Process segment ids
    try:
        if validate_segment_id([str(id) for id in echo_segment_ids]):
            param = QueryParam(
                mode="mix",
                conversation_history=payload.conversation_history,
                history_turns=10,
                only_need_prompt=True,
                ids=[str(id) for id in echo_segment_ids],
                top_k=payload.top_k,
            )
            
            try:
                response = await rag.aquery(payload.query, param=param)
                logger.debug(f"Response: {response}")
                return response
            except Exception as rag_error:
                # Graceful fallback if RAG query fails (e.g., SQL bug in lightrag-dembrane)
                logger.warning(
                    f"RAG query failed (known SQL bug in lightrag-dembrane==1.2.7.8): {rag_error}"
                )
                logger.warning("Falling back to simple context retrieval")
                
                # Return a helpful error message instead of crashing
                return (
                    "RAG query temporarily unavailable due to a known issue. "
                    "Please try using manual conversation selection mode instead, "
                    "or contact support if this persists."
                )

        else:
            raise HTTPException(status_code=400, detail="Invalid segment ID")
    except Exception as e:
        logger.exception("Query streaming operation failed")
        raise HTTPException(status_code=500, detail=str(e)) from e


class DeleteConversationRequest(BaseModel):
    conversation_ids: list[str]


@StatelessRouter.post("/rag/delete_conversation")
async def delete_conversation(
    payload: DeleteConversationRequest,
    session: DependencyDirectusSession,  # Needed for fake auth
) -> None:
    session = session

    conversation_ids = payload.conversation_ids
    for id in conversation_ids:
        if not is_valid_uuid(id):
            raise HTTPException(status_code=400, detail="Invalid conversation ID")
    # Initialize RAG
    if not RAGManager.is_initialized():
        await RAGManager.initialize()
    rag = get_rag()
    await initialize_pipeline_status()
    postgres_db = await PostgresDBManager.get_initialized_db()
    try:
        lightrag_doc_ids = await get_segment_from_conversation_ids(postgres_db, conversation_ids)
    except Exception as e:
        logger.exception("Failed to get segment from conversation ids. Check PGSQ")
        raise HTTPException(status_code=500, detail=str(e)) from e

    for doc_id in lightrag_doc_ids:
        await rag.adelete_by_doc_id(str(doc_id))
        await delete_transcript_by_doc_id(postgres_db, str(doc_id))
        delete_segment_from_directus(str(doc_id))
    logger.info(f"Deleted {len(lightrag_doc_ids)} document(s) from RAG")


@StatelessRouter.post("/webhook/transcribe")
async def transcribe_webhook(payload: dict) -> None:
    logger = getLogger("stateless.webhook.transcribe")
    logger.debug(f"Transcribe webhook received: {payload}")
    try:
        from dembrane.runpod import load_runpod_transcription_response

        load_runpod_transcription_response(payload)

    except Exception as e:
        logger.exception("Failed to update conversation chunk")
        raise HTTPException(status_code=500, detail=str(e)) from e
