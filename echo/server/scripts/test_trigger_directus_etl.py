#!/usr/bin/env python3
"""
Test script to manually trigger task_run_directus_etl.
This will help us diagnose why the task isn't executing.
"""

import os
import sys

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dembrane.tasks import task_run_directus_etl
import time

print("Testing task_run_directus_etl...")
print(f"Task registered: {task_run_directus_etl}")
print(f"Task actor name: {task_run_directus_etl.actor_name}")
print(f"Task queue: {task_run_directus_etl.queue_name}")
print(f"Task priority: {task_run_directus_etl.priority}")

# Try to send the task
test_conversation_id = "867b5445-3ef5-44ef-b092-0af0084370ae"  # From your logs
print(f"\nSending task for conversation: {test_conversation_id}")

try:
    message = task_run_directus_etl.send(test_conversation_id)
    print(f"Task sent successfully: {message}")
    print(f"Message ID: {message.message_id}")
    print(f"Waiting for result (30 second timeout)...")
    
    result = message.get_result(block=True, timeout=30000)  # 30 seconds
    print(f"Result: {result}")
    
except Exception as e:
    print(f"Error: {type(e).__name__}: {e}")
    import traceback
    traceback.print_exc()
