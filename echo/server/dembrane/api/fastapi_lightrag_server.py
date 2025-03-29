# import os
# import logging
# from contextlib import asynccontextmanager

# import uvicorn

# # Required for async operations in some environments
# import nest_asyncio
# from dotenv import load_dotenv
# from fastapi import FastAPI, Request, HTTPException
# from pydantic import BaseModel

# nest_asyncio.apply()

# # Load environment variables and set up logging
# load_dotenv()
# logging.basicConfig(level=logging.INFO)

# # Import your RAG and DB dependencies
# from lightrag import LightRAG, QueryParam
# from lightrag.llm.azure_openai import azure_openai_complete
# from lightrag.kg.postgres_impl import PostgreSQLDB
# from dembrane.audio_lightrag.utils.lightrag_utils import embedding_func

# # Define request models for validation
# class InsertRequest(BaseModel):
#     content: str

# class QueryRequest(BaseModel):
#     query: str

# @asynccontextmanager
# async def lifespan(app: FastAPI) -> None:
#     # Startup logic: initialize PostgreSQL and create the RAG object.
#     postgres_config = {
#         "host": os.environ["POSTGRES_HOST"],
#         "port": os.environ["POSTGRES_PORT"],
#         "user": os.environ["POSTGRES_USER"],
#         "password": os.environ["POSTGRES_PASSWORD"],
#         "database": os.environ["POSTGRES_DATABASE"],
#         "workspace": os.environ["POSTGRES_WORKSPACE"]
#     }

#     postgres_db = PostgreSQLDB(config=postgres_config)
#     await postgres_db.initdb()
#     await postgres_db.check_tables()

#     working_dir = os.environ["POSTGRES_WORK_DIR"]
#     if not os.path.exists(working_dir):
#         os.mkdir(working_dir)

#     app.state.rag = LightRAG(
#         working_dir=working_dir,
#         llm_model_func=azure_openai_complete,
#         embedding_func=embedding_func,
#         kv_storage="PGKVStorage",
#         doc_status_storage="PGDocStatusStorage",
#         graph_storage="PGGraphStorage",
#         vector_storage="PGVectorStorage",
#         vector_db_storage_cls_kwargs={
#             "cosine_better_than_threshold": 0.7  # tuning parameter for similarity
#         }
#     )
#     logging.info("RAG object has been initialized.")

#     # Yield control to let the app run.
#     yield

#     # # Shutdown logic: cleanup if necessary.
#     # logging.info("Shutting down FastAPI application.")

# app = FastAPI(lifespan=lifespan)

# @app.post("/insert")
# async def insert_item(request: Request, payload: InsertRequest) -> dict:
#     rag: LightRAG = request.app.state.rag
#     if rag is None:
#         raise HTTPException(status_code=500, detail="RAG object not initialized")
#     try:
#         result = rag.insert(payload.content)
#         return {"status": "success", "result": result}
#     except Exception as e:
#         logging.exception("Insert operation failed")
#         raise HTTPException(status_code=500, detail=str(e))

# @app.post("/query")
# async def query_item(request: Request, payload: QueryRequest) -> dict:
#     rag: LightRAG = request.app.state.rag
#     if rag is None:
#         raise HTTPException(status_code=500, detail="RAG object not initialized")
#     try:
#         result = rag.query(payload.query, param=QueryParam(mode="local"))
#         return {"status": "success", "result": result}
#     except Exception as e:
#         logging.exception("Query operation failed")
#         raise HTTPException(status_code=500, detail=str(e))

# if __name__ == "__main__":
#     uvicorn.run("fastapi_lightrag_server:app", host="0.0.0.0", port=8010, reload=True)
