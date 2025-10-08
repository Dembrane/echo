#!/usr/bin/env python3
"""
Test script to manually trigger task_run_etl_pipeline (THE PIVOT version).
This will help test the new simplified RAG ETL pipeline.
"""

import os
import sys

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dembrane.tasks import task_run_etl_pipeline
import time

print("Testing task_run_etl_pipeline (THE PIVOT)...")
print(f"Task registered: {task_run_etl_pipeline}")
print(f"Task actor name: {task_run_etl_pipeline.actor_name}")
print(f"Task queue: {task_run_etl_pipeline.queue_name}")
print(f"Task priority: {task_run_etl_pipeline.priority}")

# Try to send the task
test_conversation_id = input("Enter conversation ID to test: ").strip()
if not test_conversation_id:
    print("No conversation ID provided, exiting")
    sys.exit(1)

print(f"\nSending task for conversation: {test_conversation_id}")

try:
    message = task_run_etl_pipeline.send(test_conversation_id)
    print(f"Task sent successfully: {message}")
    print(f"Message ID: {message.message_id}")
    print(f"Waiting for result (5 minute timeout)...")
    
    result = message.get_result(block=True, timeout=300)
    print(f"Result: {result}")
    
except Exception as e:
    print(f"Error: {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
