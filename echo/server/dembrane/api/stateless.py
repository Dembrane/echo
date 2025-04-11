import os
import json
import asyncio
from logging import getLogger

import nest_asyncio
from fastapi import APIRouter, HTTPException
from litellm import completion
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from lightrag.lightrag import QueryParam
from lightrag.kg.postgres_impl import PostgreSQLDB
from lightrag.kg.shared_storage import initialize_pipeline_status

from dembrane.rag import RAGManager, get_rag
from dembrane.prompts import render_prompt
from dembrane.api.dependency_auth import DirectusSession, DependencyDirectusSession
from dembrane.audio_lightrag.utils.lightrag_utils import (
    get_all_segments,
    upsert_transcript,
    fetch_query_transcript,
    get_segment_from_project_ids,
    get_segment_from_conversation_chunk_ids,
)

nest_asyncio.apply()

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])

class PostgresDBManager:
    """
    Singleton class to manage the PostgreSQLDB instance.
    """
    _instance: "PostgresDBManager | None" = None
    _db: PostgreSQLDB | None = None
    _lock = asyncio.Lock() 

    def __new__(cls) -> "PostgresDBManager":
        if cls._instance is None:
            cls._instance = super(PostgresDBManager, cls).__new__(cls)
            cls._db = None
        return cls._instance

    async def _initialize_db(self) -> None:
        """Internal method to perform the actual DB initialization."""
        logger.info("Initializing PostgreSQLDB...")
        postgres_config = {
            "host": os.environ["POSTGRES_HOST"],
            "port": os.environ["POSTGRES_PORT"],
            "user": os.environ["POSTGRES_USER"],
            "password": os.environ["POSTGRES_PASSWORD"],
            "database": os.environ["POSTGRES_DATABASE"],
        }
        try:
            self._db = PostgreSQLDB(config=postgres_config)
            await self._db.initdb() 
            logger.info("PostgreSQLDB initialized successfully.")
        except Exception as e:
            logger.exception("Failed to initialize PostgreSQLDB")
            self._db = None 
            raise e 

    async def initialize(self) -> None:
        """Initializes the database connection if not already initialized. Uses a lock for async safety."""
        if self._db is None:
            async with self._lock: 
                if self._db is None: 
                   await self._initialize_db()

    def get_db(self) -> PostgreSQLDB:
        """Returns the initialized database instance. Raises error if not initialized."""
        if self._db is None:
            logger.error("PostgreSQLDB accessed before initialization.")
            raise RuntimeError("PostgreSQLDB has not been initialized. Call initialize() first.")
        return self._db

    @classmethod
    async def get_initialized_db(cls) -> PostgreSQLDB:
        """Gets the singleton instance and ensures it's initialized."""
        instance = cls()
        await instance.initialize()
        return instance.get_db()

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
async def insert_item(payload: InsertRequest,
                      session: DependencyDirectusSession #Needed for fake auth
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
            rag.insert(payload.content, 
                    ids=echo_segment_ids)
            for transcript in payload.transcripts:
                await upsert_transcript(postgres_db, 
                                    document_id = str(payload.echo_segment_id), 
                                    content = transcript)
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
async def query_item(payload: SimpleQueryRequest,
                     session: DependencyDirectusSession  #Needed for fake auth
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
            result = rag.query(payload.query, param=QueryParam(mode="mix", 
                                                            ids=echo_segment_ids if echo_segment_ids else None))
            if payload.get_transcripts:
                transcripts = await fetch_query_transcript(postgres_db, 
                                                str(result), 
                                                ids = echo_segment_ids if echo_segment_ids else None)
                transcript_contents = [t['content'] for t in transcripts] if isinstance(transcripts, list)  else [transcripts['content']] # type: ignore
            else:
                transcript_contents = []
            return SimpleQueryResponse(status="success", result=result, transcripts=transcript_contents)
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
async def get_lightrag_prompt(payload: GetLightragQueryRequest,
                       session: DependencyDirectusSession  #Needed for fake auth
                       ) -> str:
    session = session
    # Validate payload
    if not payload.auto_select_bool:
        if payload.echo_segment_ids is None and payload.echo_conversation_ids is None and payload.echo_project_ids is None:
            raise HTTPException(status_code=400, 
                                detail="At least one of echo_segment_ids, echo_conversation_ids, or echo_project_ids must be provided if auto_select_bool is False")
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
        conversation_segments = await get_segment_from_conversation_chunk_ids(postgres_db, payload.echo_conversation_ids)
        echo_segment_ids += conversation_segments
    if payload.echo_project_ids:
        project_segments = await get_segment_from_project_ids(postgres_db, payload.echo_project_ids)
        echo_segment_ids += project_segments
    if payload.auto_select_bool:
        all_segments = await get_all_segments(postgres_db, payload.echo_conversation_ids) # type: ignore
        echo_segment_ids += all_segments
    
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
            param = QueryParam(mode="mix",
                               conversation_history=payload.conversation_history,
                               history_turns=10,
                               only_need_prompt=True,
                               ids= [str(id) for id in echo_segment_ids],
                               top_k = payload.top_k)
            response = rag.aquery(payload.query, param=param)
            return response
            
        else:
            raise HTTPException(status_code=400, detail="Invalid segment ID")
    except Exception as e:
        logger.exception("Query streaming operation failed")
        raise HTTPException(status_code=500, detail=str(e)) from e
    