#!/usr/bin/env python3
"""
Simple RAG ETL Observer - Monitor LightRAG processing status

Usage:
    python simple_rag_observer.py                    # Watch all recent conversations
    python simple_rag_observer.py <conversation_id>  # Watch specific conversation
"""
import os
import sys
import time
from pathlib import Path

# Load environment
from dotenv import load_dotenv
load_dotenv(Path(__file__).parents[1] / ".env")
load_dotenv(Path(__file__).parents[3] / "local.env")

import psycopg
from neo4j import GraphDatabase
from directus_py_sdk import DirectusClient


def connect_db():
    """Connect to PostgreSQL"""
    db_url = os.getenv("DATABASE_URL")
    if db_url.startswith("postgresql+psycopg://"):
        db_url = "postgresql://" + db_url[21:]
    return psycopg.connect(db_url)


def connect_neo4j():
    """Connect to Neo4j"""
    uri = os.getenv("NEO4J_URI")
    user = os.getenv("NEO4J_USERNAME")
    password = os.getenv("NEO4J_PASSWORD")
    return GraphDatabase.driver(uri, auth=(user, password))


def get_global_stats(conn, neo4j_driver):
    """Get system-wide statistics"""
    cur = conn.cursor()
    
    # PostgreSQL counts
    cur.execute("SELECT count(*) FROM conversation")
    conversations = cur.fetchone()[0]
    
    cur.execute("SELECT count(*) FROM conversation_chunk")
    chunks = cur.fetchone()[0]
    
    cur.execute("SELECT count(*) FROM conversation_segment")
    segments = cur.fetchone()[0]
    
    cur.execute("SELECT count(*) FROM lightrag_vdb_transcript")
    vectors = cur.fetchone()[0]
    
    cur.execute("SELECT count(*) FROM lightrag_doc_status")
    docs = cur.fetchone()[0]
    
    # Neo4j counts
    with neo4j_driver.session() as session:
        result = session.run("MATCH (n) RETURN count(n) as total")
        neo4j_nodes = result.single()["total"]
    
    return {
        "conversations": conversations,
        "chunks": chunks,
        "segments": segments,
        "vectors": vectors,
        "docs": docs,
        "neo4j_nodes": neo4j_nodes,
    }


def get_conversation_details(conn, conv_id):
    """Get details for a specific conversation"""
    cur = conn.cursor()
    
    # Conversation info
    cur.execute("""
        SELECT participant_name, is_finished, is_audio_processing_finished
        FROM conversation WHERE id = %s
    """, (conv_id,))
    row = cur.fetchone()
    if not row:
        return None
    
    name, is_finished, processing_done = row
    status = "finished" if is_finished else "in_progress"
    
    # Chunks
    cur.execute("""
        SELECT count(*) FROM conversation_chunk WHERE conversation_id = %s
    """, (conv_id,))
    chunk_count = cur.fetchone()[0]
    
    # Segments via chunks
    cur.execute("""
        SELECT count(DISTINCT cs.id)
        FROM conversation_segment cs
        JOIN conversation_segment_conversation_chunk cscc ON cs.id = cscc.conversation_segment_id
        JOIN conversation_chunk cc ON cc.id = cscc.conversation_chunk_id
        WHERE cc.conversation_id = %s
    """, (conv_id,))
    segment_count = cur.fetchone()[0]
    
    return {
        "name": name,
        "status": status,
        "processing_done": processing_done,
        "chunks": chunk_count,
        "segments": segment_count,
    }


def print_stats(stats, conversation=None):
    """Print statistics"""
    print("\n" + "="*60)
    print(f"RAG ETL Observer - {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)
    
    print(f"\nGlobal Stats:")
    print(f"  Conversations: {stats['conversations']}")
    print(f"  Chunks: {stats['chunks']}")
    print(f"  Segments: {stats['segments']}")
    print(f"  Vector Transcripts: {stats['vectors']}")
    print(f"  LightRAG Docs: {stats['docs']}")
    print(f"  Neo4j Nodes: {stats['neo4j_nodes']}")
    
    if conversation:
        print(f"\nConversation Details:")
        print(f"  Name: {conversation['name']}")
        print(f"  Status: {conversation['status']}")
        print(f"  Processing Done: {conversation['processing_done']}")
        print(f"  Chunks: {conversation['chunks']}")
        print(f"  Segments: {conversation['segments']}")
    
    print("\n" + "="*60)


def main():
    # Parse arguments
    conv_id = None
    auto_mode = False
    
    for arg in sys.argv[1:]:
        if arg == "--auto":
            auto_mode = True
        elif not arg.startswith("-"):
            conv_id = arg
    
    print("Connecting to databases...")
    conn = connect_db()
    neo4j_driver = connect_neo4j()
    
    try:
        while True:
            stats = get_global_stats(conn, neo4j_driver)
            conversation = None
            
            if conv_id:
                conversation = get_conversation_details(conn, conv_id)
                if not conversation:
                    print(f"Conversation {conv_id} not found")
                    break
            
            os.system("clear")
            print_stats(stats, conversation)
            
            if conv_id and not auto_mode:
                # Single conversation mode without auto - just show once
                break
            
            # Watch mode or auto mode - refresh every 5 seconds
            time.sleep(5)
            
    except KeyboardInterrupt:
        print("\n\nExiting...")
    finally:
        conn.close()
        neo4j_driver.close()


if __name__ == "__main__":
    main()
