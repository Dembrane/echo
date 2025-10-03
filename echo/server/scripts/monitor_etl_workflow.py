#!/usr/bin/env python3
"""
Monitor ETL workflow execution in real-time.
Watches for the new 3-stage modularized ETL pipeline.

Usage:
    python scripts/monitor_etl_workflow.py
"""

import os
import sys
import time
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dembrane.utils.directus_client import get_directus_client


def monitor_workflow():
    """Monitor for ETL workflow execution."""
    directus = get_directus_client()
    
    print(f"[{datetime.now()}] Monitoring ETL workflow execution...")
    print("Looking for conversations that finish and trigger the new 3-stage ETL...\n")
    
    # Track conversations we've already seen finish
    seen_finished = set()
    
    # Track conversations currently processing audio
    seen_processing = set()
    
    try:
        while True:
            # Check for conversations that are processing audio
            processing = directus.get_items(
                "conversation",
                filter={
                    "is_enhanced_audio_processing_enabled": {"_eq": True},
                    "is_audio_processing_finished": {"_eq": False},
                },
                fields=["id", "created_at", "status"],
                limit=20
            )
            
            current_processing = {c["id"] for c in processing}
            
            # Check for newly processing conversations
            new_processing = current_processing - seen_processing
            if new_processing:
                for conv_id in new_processing:
                    print(f"[{datetime.now()}] 🔄 Conversation {conv_id[:8]}... started audio processing")
                seen_processing.update(new_processing)
            
            # Check for conversations that finished
            finished_processing = seen_processing - current_processing
            if finished_processing:
                for conv_id in finished_processing:
                    if conv_id not in seen_finished:
                        print(f"[{datetime.now()}] ✅ Conversation {conv_id[:8]}... FINISHED audio processing!")
                        print(f"    → This should trigger the new 3-stage ETL workflow:")
                        print(f"       1. task_run_directus_etl (10 min)")
                        print(f"       2. task_run_audio_etl (15 min)")  
                        print(f"       3. task_run_contextual_etl (35 min)")
                        print(f"    → Check dramatiq logs for 'Starting 3-stage ETL pipeline'\n")
                        seen_finished.add(conv_id)
                
                seen_processing -= finished_processing
            
            # Show current state
            if len(processing) > 0:
                print(f"[{datetime.now()}] Currently processing: {len(processing)} conversations")
            
            time.sleep(10)  # Check every 10 seconds
            
    except KeyboardInterrupt:
        print(f"\n[{datetime.now()}] Monitoring stopped.")


if __name__ == "__main__":
    monitor_workflow()
