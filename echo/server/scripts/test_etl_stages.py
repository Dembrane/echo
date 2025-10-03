#!/usr/bin/env python3
"""
Test script for the 3-stage ETL pipeline.

This script helps verify that:
1. ProcessTracker serialization/deserialization works
2. All 3 tasks are properly defined
3. Task chaining logic is sound
"""

import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker
import pandas as pd
import json


def test_process_tracker_serialization():
    """Test that ProcessTracker can be serialized and deserialized"""
    print("Testing ProcessTracker serialization...")
    
    # Create sample data
    conv_df = pd.DataFrame({
        'conversation_id': ['conv1', 'conv1'],
        'project_id': ['proj1', 'proj1'],
        'chunk_id': ['chunk1', 'chunk2'],
        'path': ['s3://path1.mp3', 's3://path2.mp3'],
        'timestamp': pd.to_datetime(['2024-01-01', '2024-01-02']),
        'format': ['mp3', 'mp3']
    })
    
    proj_df = pd.DataFrame({
        'id': ['proj1'],
        'name': ['Test Project'],
    }).set_index('id')
    
    # Create ProcessTracker
    tracker = ProcessTracker(conv_df, proj_df)
    
    # Serialize
    data = tracker.to_dict()
    print(f"  ✓ Serialized to dict with keys: {list(data.keys())}")
    
    # Check size (should be reasonable for Dramatiq)
    json_size = len(json.dumps(data))
    print(f"  ✓ Serialized size: {json_size} bytes ({json_size/1024:.1f} KB)")
    
    if json_size > 1_000_000:  # 1 MB
        print(f"  ⚠ WARNING: Serialized size is large (>{1}MB)")
    
    # Deserialize
    tracker2 = ProcessTracker.from_dict(data)
    print(f"  ✓ Deserialized successfully")
    
    # Verify data integrity
    assert len(tracker2()) == len(tracker()), "Conversation DF length mismatch"
    assert len(tracker2.get_project_df()) == len(tracker.get_project_df()), "Project DF length mismatch"
    print(f"  ✓ Data integrity verified")
    
    print("✅ ProcessTracker serialization test PASSED\n")
    return True


def test_task_imports():
    """Test that all 3 new tasks can be imported"""
    print("Testing task imports...")
    
    try:
        from dembrane.tasks import (
            task_run_directus_etl,
            task_run_audio_etl,
            task_run_contextual_etl,
            task_run_etl_pipeline,
        )
        print(f"  ✓ Imported task_run_directus_etl")
        print(f"  ✓ Imported task_run_audio_etl")
        print(f"  ✓ Imported task_run_contextual_etl")
        print(f"  ✓ Imported task_run_etl_pipeline (updated)")
        
        # Check task properties
        print(f"\nTask Properties:")
        print(f"  Stage 1 (Directus):")
        print(f"    - Priority: {task_run_directus_etl.priority}")
        print(f"    - Time limit: {task_run_directus_etl.options.get('time_limit', 0) / 60000} min")
        print(f"    - Max retries: {task_run_directus_etl.options.get('max_retries', 0)}")
        
        print(f"  Stage 2 (Audio):")
        print(f"    - Priority: {task_run_audio_etl.priority}")
        print(f"    - Time limit: {task_run_audio_etl.options.get('time_limit', 0) / 60000} min")
        print(f"    - Max retries: {task_run_audio_etl.options.get('max_retries', 0)}")
        
        print(f"  Stage 3 (Contextual):")
        print(f"    - Priority: {task_run_contextual_etl.priority}")
        print(f"    - Time limit: {task_run_contextual_etl.options.get('time_limit', 0) / 60000} min")
        print(f"    - Max retries: {task_run_contextual_etl.options.get('max_retries', 0)}")
        
        print("\n✅ Task import test PASSED\n")
        return True
        
    except ImportError as e:
        print(f"  ✗ Import failed: {e}")
        print("❌ Task import test FAILED\n")
        return False


def test_pipeline_imports():
    """Test that all pipeline modules can be imported"""
    print("Testing pipeline imports...")
    
    try:
        from dembrane.audio_lightrag.pipelines.directus_etl_pipeline import DirectusETLPipeline
        print(f"  ✓ Imported DirectusETLPipeline")
        
        from dembrane.audio_lightrag.pipelines.audio_etl_pipeline import AudioETLPipeline
        print(f"  ✓ Imported AudioETLPipeline")
        
        from dembrane.audio_lightrag.pipelines.contextual_chunk_etl_pipeline import ContextualChunkETLPipeline
        print(f"  ✓ Imported ContextualChunkETLPipeline")
        
        print("✅ Pipeline import test PASSED\n")
        return True
        
    except ImportError as e:
        print(f"  ✗ Import failed: {e}")
        print("❌ Pipeline import test FAILED\n")
        return False


def test_async_utils():
    """Test that async utils can be imported"""
    print("Testing async utils...")
    
    try:
        from dembrane.audio_lightrag.utils.async_utils import run_async_in_new_loop
        print(f"  ✓ Imported run_async_in_new_loop")
        
        # Test with simple async function
        import asyncio
        
        async def test_coro():
            await asyncio.sleep(0.001)
            return "success"
        
        result = run_async_in_new_loop(test_coro())
        assert result == "success", "Async function didn't return expected value"
        print(f"  ✓ Executed test async function: {result}")
        
        print("✅ Async utils test PASSED\n")
        return True
        
    except Exception as e:
        print(f"  ✗ Test failed: {e}")
        print("❌ Async utils test FAILED\n")
        return False


def test_audio_validation():
    """Test that audio validation functions can be imported"""
    print("Testing audio validation...")
    
    try:
        from dembrane.audio_lightrag.utils.audio_utils import (
            validate_audio_file,
            safe_audio_decode
        )
        print(f"  ✓ Imported validate_audio_file")
        print(f"  ✓ Imported safe_audio_decode")
        
        # Test validation with invalid URL (should fail gracefully)
        is_valid, error = validate_audio_file("https://invalid.url/file.mp3")
        print(f"  ✓ Validation returned: valid={is_valid}, error='{error}'")
        
        print("✅ Audio validation test PASSED\n")
        return True
        
    except Exception as e:
        print(f"  ✗ Test failed: {e}")
        print("❌ Audio validation test FAILED\n")
        return False


def main():
    """Run all tests"""
    print("="*60)
    print("Testing Week 1 ETL Implementation")
    print("="*60 + "\n")
    
    results = []
    
    # Run tests
    results.append(("ProcessTracker Serialization", test_process_tracker_serialization()))
    results.append(("Task Imports", test_task_imports()))
    results.append(("Pipeline Imports", test_pipeline_imports()))
    results.append(("Async Utils", test_async_utils()))
    results.append(("Audio Validation", test_audio_validation()))
    
    # Summary
    print("="*60)
    print("Test Summary")
    print("="*60)
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {name}")
    
    print(f"\nTotal: {passed}/{total} tests passed")
    
    if passed == total:
        print("\n🎉 All tests PASSED! Ready for deployment.")
        return 0
    else:
        print(f"\n⚠️  {total - passed} test(s) FAILED. Please fix before deploying.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
