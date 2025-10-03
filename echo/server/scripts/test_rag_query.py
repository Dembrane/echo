#!/usr/bin/env python3
"""
Test script to query LightRAG and see the response.

This helps verify that:
1. LightRAG has data
2. RAG queries work correctly
3. You can see what data is being returned
"""

import sys
import os
import asyncio

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dembrane.rag_manager import RAGManager
from dembrane.audio_lightrag.utils.async_utils import run_async_in_new_loop


async def test_rag_query(query: str):
    """Test a RAG query"""
    print(f"\nQuerying LightRAG with: '{query}'")
    print("="*60)
    
    # Initialize RAG
    if not RAGManager.is_initialized():
        print("Initializing RAG...")
        await RAGManager.initialize()
    
    rag = RAGManager.get_instance()
    
    # Query RAG
    from lightrag.lightrag import QueryParam
    print("\nSearching...")
    result = await rag.aquery(query, param=QueryParam(mode="local"))
    
    print(f"\nResult:")
    print("-"*60)
    print(result)
    print("-"*60)
    
    return result


def main():
    """Run test queries"""
    print("="*60)
    print("LightRAG Query Test")
    print("="*60)
    
    # Default test query
    query = sys.argv[1] if len(sys.argv) > 1 else "What topics have been discussed in conversations?"
    
    # Run query in new event loop (like Dramatiq tasks do)
    result = run_async_in_new_loop(test_rag_query(query))
    
    print(f"\n✓ Query completed")
    print(f"  Result length: {len(result)} characters")
    
    # Show some stats
    if "no relevant" in result.lower() or "no information" in result.lower():
        print("\n⚠️  RAG returned 'no relevant information'")
        print("  This means either:")
        print("    1. ETL pipeline hasn't finished processing conversations yet")
        print("    2. No data matches your query")
        print("    3. LightRAG database is empty")
    else:
        print("\n✓ RAG found relevant information!")


if __name__ == "__main__":
    main()
