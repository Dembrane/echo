# import os
import os
import re
import uuid
import asyncio
import hashlib
import logging
from typing import Any, Dict, Literal, TypeVar, Callable, Optional

import redis
from lightrag.kg.postgres_impl import PostgreSQLDB

from dembrane.directus import directus
from dembrane.postgresdbmanager import PostgresDBManager
from dembrane.audio_lightrag.utils.litellm_utils import embedding_func

logger = logging.getLogger('audio_lightrag_utils')



# Redis lock configuration
REDIS_LOCK_KEY = "DEMBRANE_INIT_LOCK"
REDIS_LOCK_TIMEOUT = 600  # 10 minutes in seconds
REDIS_LOCK_RETRY_INTERVAL = 2  # seconds
REDIS_LOCK_MAX_RETRIES = 60  # 2 minutes of retries

T = TypeVar('T')

def is_valid_uuid(uuid_str: str) -> bool:
    try:
        uuid.UUID(uuid_str)
        return True
    except ValueError:
        return False

# Hierachy:
# Chunk is the lowest level
# Conversation is a collection of chunks
# Project is a collection of conversations
# Segment is a many to many of chunks

db_manager = PostgresDBManager()

def get_conversation_name_from_id(conversation_id: str) -> str:
    query = {'query': {'filter': {'id': {'_eq': conversation_id}},'fields': ['participant_name']}}
    return directus.get_items("conversation", query)[0]['participant_name']

async def run_segment_id_to_conversation_id(segment_id: int) -> str:
    conversation_chunk_dict = await run_segment_ids_to_conversation_chunk_ids([segment_id])
    conversation_chunk_ids = list(conversation_chunk_dict.values())
    query = {'query': {'filter': {'id': {'_in': conversation_chunk_ids}},'fields': ['conversation_id']}}
    return directus.get_items("conversation_chunk", query)[0]['conversation_id']


async def run_segment_ids_to_conversation_chunk_ids(segment_ids: list[int]) -> dict[int, str]:
    db = await db_manager.get_initialized_db()
    return await get_conversation_chunk_ids_from_segment_ids(db, segment_ids)

async def get_conversation_chunk_ids_from_segment_ids(db: PostgreSQLDB,
                                                      segment_ids: list[int]) -> dict[int, str]:
    # Validate each item is an integer in segment_ids
    for segment_id in segment_ids:
        if not isinstance(segment_id, int):
            raise ValueError(f"Invalid segment ID: {segment_id}")
    segment_ids = ','.join([str(segment_id) for segment_id in segment_ids]) #type: ignore
    sql = SQL_TEMPLATES["GET_CONVERSATION_CHUNK_IDS_FROM_SEGMENT_IDS"].format(segment_ids=segment_ids)
    result = await db.query(sql, multirows=True)
    return {int(x['conversation_segment_id']): str(x['conversation_chunk_id']) for x in result}

async def get_segment_from_conversation_chunk_ids(db: PostgreSQLDB,
                                                  conversation_chunk_ids: list[str]) -> list[int]:
    # Validate each item is a UUID in conversation_chunk_ids
    for conversation_chunk_id in conversation_chunk_ids:
        if not is_valid_uuid(conversation_chunk_id):
            raise ValueError(f"Invalid UUID: {conversation_chunk_id}")
        
    conversation_chunk_ids = ','.join(["UUID('" + conversation_id + "')" 
                                for conversation_id in conversation_chunk_ids]) #type: ignore
    sql = SQL_TEMPLATES["GET_SEGMENT_IDS_FROM_CONVERSATION_CHUNK_IDS"
                        ].format(conversation_ids=conversation_chunk_ids)
    result = await db.query(sql, multirows=True)
    return [int(x['conversation_segment_id']) for x in result if x['conversation_segment_id'] is not None]

async def get_segment_from_conversation_ids(db: PostgreSQLDB,
                                      conversation_ids: list[str]) -> list[int]:
    conversation_request = {"query": 
                                     {"fields": ["chunks.id"], 
                                           "limit": 100000,
                                           "deep": {"chunks": 
                                                    {"_limit": 100000, "_sort": "timestamp"}
                                                    },
                                        # "filter": {"id": {"_in": ['0c6b0061-f6ec-490d-b279-0715ca9a7994']}}
                                                }
                            }
    conversation_request["query"]["filter"] = {"id": {"_in": conversation_ids}}
    conversation_request_result = directus.get_items("conversation", conversation_request)
    conversation_chunk_ids = [[x['id'] for x in conversation_request_result_dict['chunks']] for conversation_request_result_dict in conversation_request_result]
    flat_conversation_chunk_ids: list[str] = [item for sublist in conversation_chunk_ids for item in sublist if item is not None]
    return await get_segment_from_conversation_chunk_ids(db, flat_conversation_chunk_ids)

async def get_segment_from_project_ids(db: PostgreSQLDB,
                                 project_ids: list[str]) -> list[int]:
    project_request = {"query": {"fields": ["conversations.id"], 
                                           "limit": 100000,
                                           }}
    project_request["query"]["filter"] = {"id": {"_in": project_ids}}
    project_request_result = directus.get_items("project", project_request)
    conversation_ids = [[x['id'] for x in project_request_result_dict['conversations']] for project_request_result_dict in project_request_result]
    flat_conversation_ids: list[str] = [item for sublist in conversation_ids for item in sublist if item is not None]
    return await get_segment_from_conversation_ids(db, flat_conversation_ids)

async def with_distributed_lock(
    redis_url: str,
    lock_key: str = REDIS_LOCK_KEY,
    timeout: int = REDIS_LOCK_TIMEOUT,
    retry_interval: int = REDIS_LOCK_RETRY_INTERVAL,
    max_retries: int = REDIS_LOCK_MAX_RETRIES,
    critical_operation: Optional[Callable[[], Any]] = None
) -> tuple[bool, Any]:
    """
    Execute critical operations with a distributed lock using Redis.
    
    Args:
        redis_url: Redis connection URL
        lock_key: Key to use for the lock
        timeout: Lock expiration time in seconds
        retry_interval: Time to wait between lock acquisition attempts
        max_retries: Maximum number of lock acquisition attempts
        critical_operation: Optional async function to execute under lock
        
    Returns:
        Tuple of (lock_acquired: bool, result: Any)
    """
    logger.info(f"Attempting to acquire distributed lock: {lock_key}")
    
    # Connect to Redis
    redis_client = redis.from_url(redis_url)
    
    # Try to acquire lock
    lock_acquired = False
    retries = 0
    result = None
    
    while not lock_acquired and retries < max_retries:
        # Try to set the key only if it doesn't exist with an expiry
        lock_acquired = redis_client.set(
            lock_key, 
            os.environ.get("HOSTNAME", "unknown"),  # Store pod hostname for debugging
            nx=True,  # Only set if key doesn't exist
            ex=timeout  # Expire after timeout
        )
        
        if lock_acquired:
            logger.info(f"Acquired distributed lock: {lock_key}")
            try:
                # Execute critical operation if provided
                if critical_operation:
                    result = await critical_operation()
                    logger.info(f"Critical operation completed successfully under lock: {lock_key}")
            except Exception as e:
                logger.error(f"Error during critical operation under lock {lock_key}: {str(e)}")
                # Release lock in case of error to allow another process to try
                redis_client.delete(lock_key)
                raise
            finally:
                # Release the lock if we acquired it
                redis_client.delete(lock_key)
                logger.info(f"Released distributed lock: {lock_key}")
            break
        else:
            # Wait for lock to be released or become available
            logger.info(f"Waiting for distributed lock (attempt {retries+1}/{max_retries}): {lock_key}")
            retries += 1
            await asyncio.sleep(retry_interval)  
    
    if not lock_acquired:
        logger.info(f"Could not acquire distributed lock after {max_retries} attempts: {lock_key}")
    
    return lock_acquired, result

async def check_audio_lightrag_tables(db: PostgreSQLDB) -> None:
    for _, table_definition in TABLES.items():
        await db.execute(table_definition)

async def upsert_transcript(db: PostgreSQLDB, 
                            document_id: str, 
                            content: str,
                            id: str | None = None,) -> None:
    if id is None:
        # generate random id
        s = str(document_id) + str(content)
        id = str(document_id) + '_' + str(int(hashlib.sha256(s.encode('utf-8')).hexdigest(), 16) % 10**8)
    
    content_embedding = await embedding_func([content])
    content_embedding = '[' + ','.join([str(x) for x in content_embedding[0]]) + ']' # type: ignore

    sql = SQL_TEMPLATES["UPSERT_TRANSCRIPT"]
    data = {
        "id": id,
        "document_id": document_id,
        "content": content,
        "content_vector": content_embedding
    }
    await db.execute(sql = sql, data=data)

async def fetch_query_transcript(db: PostgreSQLDB, 
                           query: str,
                           ids: list[str] | str | None = None,
                           limit: int = 10) -> list[str] | None:
    if ids is None:
        ids = 'NULL'
        filter = 'NULL'
    else:
        ids = ','.join(["'" + str(id) + "'" for id in ids])
        filter = '1'
    
    
    # await db.initdb() # Need to test if this is needed
    query_embedding = await embedding_func([query])
    query_embedding = ','.join([str(x) for x in query_embedding[0]]) # type: ignore
    sql = SQL_TEMPLATES["QUERY_TRANSCRIPT"].format(
        embedding_string=query_embedding, limit=limit, doc_ids=ids, filter=filter)
    result = await db.query(sql, multirows=True)
    return result

def fetch_segment_ratios(response_text: str) -> dict[int, float]:
    
    # Find all occurrences of SEGMENT_ID_ followed by numbers
    segment_ids = re.findall(r'SEGMENT_ID_\d+', response_text)
    
    if len(segment_ids) == 0:
        return {}
    # Create a dictionary to store the count of each segment ID
    segment_count: dict[str, int] = {}
    for segment_id in segment_ids:
        segment_count[segment_id] = segment_count.get(segment_id, 0) + 1
    
    segment2count = {int(segment_id.split('_')[-1]): count for segment_id, count in segment_count.items()}
    total_count = sum(segment2count.values())
    return {k:v/total_count for k,v in segment2count.items()}

async def get_ratio_abs(rag_prompt: str, 
                        return_type: Literal["segment", "chunk", "conversation"]) -> Dict[str, float]:
        segment_ratios_abs = fetch_segment_ratios(str(rag_prompt))
        if segment_ratios_abs == {}:
            return {}
        if return_type == "segment":
            return {str(k):v for k,v in segment_ratios_abs.items()}
        segment2chunk = await run_segment_ids_to_conversation_chunk_ids(list(segment_ratios_abs.keys()))
        chunk_ratios_abs: Dict[str, float] = {}
        for segment,ratio in segment_ratios_abs.items():
            if segment in segment2chunk.keys():
                if segment2chunk[segment] not in chunk_ratios_abs.keys():
                    chunk_ratios_abs[segment2chunk[segment]] = ratio
                else:
                    chunk_ratios_abs[segment2chunk[segment]] += ratio

        #normalize chunk_ratios_abs
        total_ratio = sum(chunk_ratios_abs.values())
        chunk_ratios_abs = {k:v/total_ratio for k,v in chunk_ratios_abs.items()}

        if return_type == "chunk":
            return chunk_ratios_abs
        conversation_ratios_abs: Dict[str, float] = {}
        for chunk_id,ratio in chunk_ratios_abs.items():
            query = {'query': {'filter': {'id': {'_eq': chunk_id}},'fields': ['conversation_id']}}
            conversaion = directus.get_items("conversation_chunk", query)[0]['conversation_id']
            if conversaion not in conversation_ratios_abs.keys():
                conversation_ratios_abs[conversaion] = ratio
            else:
                conversation_ratios_abs[conversaion] += ratio
        return conversation_ratios_abs

def get_project_id(proj_chat_id: str) -> str:
    query = {'query': {'filter': {'id': {'_eq': proj_chat_id}},'fields': ['project_id']}}
    return directus.get_items("project_chat", query)[0]['project_id']

async def get_conversation_details_for_rag_query(rag_prompt: str) -> dict[str, dict[str, Any]]:
    ratio_abs = await get_ratio_abs(rag_prompt, "conversation")
    logger.debug(f'*** ratio_abs: {ratio_abs}')
    conversation_details_dict = {}
    for conversation_id,ratio in ratio_abs.items():
        query = {'query': {'filter': {'id': {'_eq': conversation_id}},'fields': ['participant_name']}}
        conversation_title = directus.get_items("conversation", query)[0]['participant_name']
        conversation_details_dict[conversation_id] = {'ratio': ratio, 'conversation_title': conversation_title}
    logger.debug(f'*** conversation_details_dict: {conversation_details_dict}')
    return conversation_details_dict

TABLES = {
    "LIGHTRAG_VDB_TRANSCRIPT": """
    CREATE TABLE IF NOT EXISTS LIGHTRAG_VDB_TRANSCRIPT (
    id VARCHAR(255),
    document_id VARCHAR(255),
    content TEXT,
    content_vector VECTOR,
    create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    update_time TIMESTAMP,
    CONSTRAINT LIGHTRAG_VDB_TRANSCRIPT_PK PRIMARY KEY (id)
    )
    """
}

SQL_TEMPLATES = {
    "UPSERT_TRANSCRIPT": 
    """
        INSERT INTO LIGHTRAG_VDB_TRANSCRIPT (id, document_id, content, content_vector)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
        document_id = $2,
        content = $3,
        content_vector = $4
    """, 
    "QUERY_TRANSCRIPT": 
    """
        WITH relevant_chunks AS (
            SELECT id as chunk_id
            FROM LIGHTRAG_VDB_TRANSCRIPT
            WHERE {filter} IS NULL OR document_id = ANY(ARRAY[{doc_ids}])
        )
        SELECT content FROM
            (
                SELECT id, content,
                1 - (content_vector <=> '[{embedding_string}]'::vector) as distance
                FROM LIGHTRAG_VDB_TRANSCRIPT
                WHERE id IN (SELECT chunk_id FROM relevant_chunks)
            )
            ORDER BY distance DESC
            LIMIT {limit}
    """,
    "GET_SEGMENT_IDS_FROM_CONVERSATION_CHUNK_IDS":
    """
    SELECT conversation_segment_id FROM conversation_segment_conversation_chunk_1
    WHERE conversation_chunk_id = ANY(ARRAY[{conversation_ids}])
    """,
    "GET_CONVERSATION_CHUNK_IDS_FROM_SEGMENT_IDS":
    """
    SELECT conversation_chunk_id, conversation_segment_id FROM conversation_segment_conversation_chunk_1
    WHERE conversation_segment_id = ANY(ARRAY[{segment_ids}])
    """
}