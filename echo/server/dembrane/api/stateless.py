import os
import asyncio
import hashlib
from logging import getLogger

import requests
import nest_asyncio
from fastapi import APIRouter, HTTPException
from litellm import completion
from pydantic import BaseModel
from lightrag.lightrag import QueryParam
from lightrag.kg.postgres_impl import PostgreSQLDB
from lightrag.kg.shared_storage import initialize_pipeline_status

from dembrane.rag import RAGManager, get_rag
from dembrane.config import RUNPOD_API_KEY, RUNPOD_API_BASE_URL
from dembrane.prompts import render_prompt
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.audio_lightrag.utils.lightrag_utils import (
    upsert_speaker,
    upsert_transcript,
    fetch_query_transcript,
    fetch_best_match_speaker,
)

nest_asyncio.apply()

logger = getLogger("api.stateless")

StatelessRouter = APIRouter(tags=["stateless"])

class PostgresDBManager:
    _instance = None
    _db: PostgreSQLDB | None = None
    _lock = asyncio.Lock() 

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(PostgresDBManager, cls).__new__(cls)
            cls._db = None
        return cls._instance

    async def _initialize_db(self):
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

    async def initialize(self):
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

class QueryRequest(BaseModel):
    query: str
    echo_segment_ids: list[str] | None = None
    get_transcripts: bool = False

class QueryResponse(BaseModel):
    status: str
    result: str
    transcripts: list[str]

@StatelessRouter.post("/rag/query")
async def query_item(payload: QueryRequest,
                     session: DependencyDirectusSession  #Needed for fake auth
                     ) -> QueryResponse:
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
            return QueryResponse(status="success", result=result, transcripts=transcript_contents)
        else:
            raise HTTPException(status_code=400, detail="Invalid segment ID")
    except Exception as e:
        logger.exception("Query operation failed")
        raise HTTPException(status_code=500, detail=str(e)) from e

class DiarizationRequest(BaseModel):
    audio_data: str 
    file_type: str

class DiarizationResponse(BaseModel):
    status: str
    speaker_ids_mapping: dict
    diarization_dict_li: list[dict]

@StatelessRouter.post("/rag/diarization")
async def diarization(payload: DiarizationRequest,
                      session: DependencyDirectusSession  #Needed for fake auth
                      ) -> DiarizationResponse:
    session = session
    
    try:
        postgres_db = await PostgresDBManager.get_initialized_db()
    except Exception as e:
        logger.exception("Failed to get initialized PostgreSQLDB for diarization")
        raise HTTPException(status_code=500, detail="Database connection failed") from e
    
    headers = {
    'Content-Type': 'application/json',
    'Authorization': f'Bearer {RUNPOD_API_KEY}'}
    json_input = {
        "input": {
            "audio_data": payload.audio_data,
            "file_type": payload.file_type
        }
    }
    response = requests.post(RUNPOD_API_BASE_URL, 
                            headers=headers, 
                            json=json_input)
    if response.status_code != 200:
        raise HTTPException(status_code=500, detail="Diarization failed")
    else:
        diarization_dict_li = response.json()['output']['diarization']
        speaker_ids_mapping = {}
        for speaker_id, embedding_vector in response.json()['output']['embeddings_dict'].items():
            new_speaker_id = 'speaker_' + hashlib.shake_256(
                (
                payload.audio_data + speaker_id
                ).encode()).hexdigest(3)
            embedding_string = ','.join([str(x) for x in embedding_vector])
            map_id = await _get_or_create_speaker_id(postgres_db, 
                                                     new_speaker_id, 
                                                     embedding_string)
            speaker_ids_mapping[speaker_id] = map_id
        diarization_dict_li = [
            {
                k: speaker_ids_mapping[v] if k == 'speaker' else v 
                for k, v in dirz_dict.items()
            } 
            for dirz_dict in diarization_dict_li
        ]
        return DiarizationResponse(status="success", 
                                   speaker_ids_mapping= speaker_ids_mapping,
                                   diarization_dict_li=diarization_dict_li
                                   )

async def _get_or_create_speaker_id(postgres_db: PostgreSQLDB, 
                                    new_speaker_id: str, 
                                    embedding_string: str) -> str:
    best_match_speaker_id = await fetch_best_match_speaker(postgres_db,
                                                            embedding_string)
    found_speaker_id = None
    if best_match_speaker_id is None:
        await upsert_speaker(postgres_db, 
                            new_speaker_id, 
                            embedding_string)
    else:
        found_speaker_id = best_match_speaker_id
    return found_speaker_id or new_speaker_id
