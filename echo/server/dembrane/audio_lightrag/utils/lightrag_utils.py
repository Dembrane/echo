# import os

import hashlib
import logging

import numpy as np
from litellm import embedding
from lightrag.kg.postgres_impl import PostgreSQLDB

# from lightrag.kg.postgres_impl import PostgreSQLDB
from dembrane.config import (
    AZURE_EMBEDDING_API_KEY,
    AZURE_EMBEDDING_ENDPOINT,
    AZURE_OPENAI_API_VERSION,
    AZURE_EMBEDDING_DEPLOYMENT,
)

# from dembrane.audio_lightrag.utils.azure_utils import setup_azure_client

logger = logging.getLogger('audio_lightrag_utils')

# async def embedding_func(texts: list[str]) -> np.ndarray:
#     response = embedding(
#         model=f"azure/{AZURE_EMBEDDING_DEPLOYMENT}",
#         input=texts,
#         api_key=str(AZURE_EMBEDDING_API_KEY),
#         api_base=str(AZURE_EMBEDDING_ENDPOINT),
#         api_version=str(AZURE_OPENAI_API_VERSION),
#     )
    
#     embeddings = [item['embedding'] for item in response.data]
#     return np.array(embeddings)


async def embedding_func(texts: list[str]) -> np.ndarray:
    # Bug in litellm forcing us to do this: https://github.com/BerriAI/litellm/issues/6967
    nd_arr_response = []
    for text in texts:
        temp = embedding(
            model=f"azure/{AZURE_EMBEDDING_DEPLOYMENT}",
            input=text,
            api_key=str(AZURE_EMBEDDING_API_KEY),
            api_base=str(AZURE_EMBEDDING_ENDPOINT),
            api_version=str(AZURE_OPENAI_API_VERSION),
        )
        nd_arr_response.append(temp['data'][0]['embedding'])
    # embeddings = [item['embedding'] for item in response.data]
    return np.array(nd_arr_response)

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
    """
}

# if __name__ == "__main__":
#     # # test the embedding function
#     import os
#     import asyncio
#     texts = ["Hello, world!", "This is a test."]
#     embeddings = asyncio.run(embedding_func(texts))
#     print(embeddings)



    # postgres_config = {
    #     "host": os.environ["POSTGRES_HOST"],
    #     "port": os.environ["POSTGRES_PORT"],
    #     "user": os.environ["POSTGRES_USER"],
    #     "password": os.environ["POSTGRES_PASSWORD"],
    #     "database": os.environ["POSTGRES_DATABASE"],
    # }

    # # test the upsert transcript function
    # db = PostgreSQLDB(config=postgres_config)
    
    # asyncio.run(fetch_query_transcript(db, "Hello, world!", ids=["test-document-129", 
    #                                                              "test-document-129", 
    #                                                              "test-document-123"]))
