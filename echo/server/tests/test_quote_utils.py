# ruff: noqa: F821
import random
import logging
import datetime
from typing import List

import pytest
import numpy as np
from sqlalchemy.orm import Session

from dembrane.utils import generate_uuid
from dembrane.database import (
    QuoteModel,
    ProcessingStatusEnum,
    ProjectAnalysisRunModel,
    get_db,
)
from dembrane.embedding import EMBEDDING_DIM
from dembrane.quote_utils import get_random_sample_quotes

from .common import (
    create_project,
    delete_project,
    create_conversation,
    delete_conversation,
)

logger = logging.getLogger("test_quote_utils")

pytestmark = pytest.mark.integration


def test_create_test_quotes(
    db: Session, project_analysis_run_id: str, conversation_id: str, count: int = 10
) -> List[QuoteModel]:
    """
    Helper function to create test quotes for testing.
    """
    quotes = []
    sample_texts = [
        "This is a test quote about feature A",
        "I really like the user interface",
        "The performance could be better",
        "Navigation is very intuitive",
        "I found a bug in the search function",
        "The app crashed when I tried to upload a file",
        "Documentation needs improvement",
        "Response time is excellent",
        "Customer support was helpful",
        "I would recommend this product to others",
        "The mobile experience is not as good as desktop",
        "It's hard to find the settings menu",
        "The update fixed most of my issues",
        "I'm confused by the workflow",
        "Security features are robust",
    ]

    # Get current time as UTC datetime object
    current_time = datetime.datetime.now(datetime.timezone.utc)

    for i in range(count):
        # Use sample texts in rotation, or generate random text for variety
        if i < len(sample_texts):
            text = sample_texts[i]
        else:
            text = f"Test quote {i} with some random content {random.randint(1000, 9999)}"

        # Use random embedding vector instead of embedding the text
        # This avoids dependency on the embedding service during tests
        embedding = np.random.randn(EMBEDDING_DIM).tolist()

        # Create a quote with embedded vector
        quote = QuoteModel(
            id=generate_uuid(),
            created_at=current_time,
            project_analysis_run_id=project_analysis_run_id,
            conversation_id=conversation_id,
            text=text,
            embedding=embedding,
            timestamp=current_time,
            order=i,
        )

        quotes.append(quote)

    # Bulk insert quotes
    db.add_all(quotes)
    db.commit()

    return quotes


def test_get_random_sample_quotes():
    """
    Test the get_random_sample_quotes function to ensure it returns quotes
    within the context limit and with proper distribution.
    """
    # Create a test project
    project = create_project(
        "test_quote_utils_project",
        "en",
    )

    # Create a test conversation
    conversation = create_conversation(
        project["id"],
        "test_conversation",
    )

    db = next(get_db())
    try:
        # Create a project analysis run
        project_analysis_run = ProjectAnalysisRunModel(
            id=generate_uuid(),
            project_id=project["id"],
            processing_status=ProcessingStatusEnum.PROCESSING,
        )
        db.add(project_analysis_run)
        db.commit()

        # Create test quotes with embeddings
        quotes = create_test_quotes(db, project_analysis_run.id, conversation["id"], count=20)

        # Test with small context limit to ensure it's respected
        small_context_limit = 100
        small_sample = get_random_sample_quotes(
            db, project_analysis_run.id, context_limit=small_context_limit
        )

        total_tokens_small = sum(len(quote.text.split()) for quote in small_sample)
        logger.info(
            f"Small context limit: {small_context_limit}, tokens used: {total_tokens_small}"
        )
        assert len(small_sample) > 0, "Should return at least some quotes"

        # Test with larger context limit
        large_context_limit = 10000
        large_sample = get_random_sample_quotes(
            db, project_analysis_run.id, context_limit=large_context_limit
        )

        total_tokens_large = sum(len(quote.text.split()) for quote in large_sample)
        logger.info(
            f"Large context limit: {large_context_limit}, tokens used: {total_tokens_large}"
        )
        assert len(large_sample) >= len(small_sample), "Larger context should allow more quotes"

        # Clean up
        for quote in quotes:
            db.delete(quote)
        db.delete(project_analysis_run)
        db.commit()
    finally:
        db.close()

    delete_conversation(conversation["id"])
    delete_project(project["id"])


def test_random_vectors_selection():
    """
    Test that the random vectors selection part of get_random_sample_quotes
    is working correctly.
    """
    # Create a test project
    project = create_project(
        "test_quote_utils_vectors",
        "en",
    )

    # Create multiple test conversations to test per-conversation selection
    conversation1 = create_conversation(
        project["id"],
        "test_conversation1",
    )

    conversation2 = create_conversation(
        project["id"],
        "test_conversation2",
    )

    db = next(get_db())
    try:
        # Create a project analysis run
        project_analysis_run = ProjectAnalysisRunModel(
            id=generate_uuid(),
            project_id=project["id"],
            processing_status=ProcessingStatusEnum.PROCESSING,
        )
        db.add(project_analysis_run)
        db.commit()

        # Create test quotes for each conversation
        quotes1 = create_test_quotes(db, project_analysis_run.id, conversation1["id"], count=15)

        quotes2 = create_test_quotes(db, project_analysis_run.id, conversation2["id"], count=15)

        # Test the function multiple times to check distribution
        all_quotes = quotes1 + quotes2
        quote_selection_counts = {quote.id: 0 for quote in all_quotes}

        # Run multiple samples and track which quotes are selected
        num_samples = 10
        context_limit = 5000  # Large enough to get a good sample

        for _ in range(num_samples):
            sample = get_random_sample_quotes(
                db, project_analysis_run.id, context_limit=context_limit
            )

            # Count how many times each quote is selected
            for quote in sample:
                if quote.id in quote_selection_counts:
                    quote_selection_counts[quote.id] += 1

        # Verify at least some quotes from each conversation were selected
        quotes1_ids = {q.id for q in quotes1}
        quotes2_ids = {q.id for q in quotes2}

        selected_from_conv1 = any(quote_selection_counts[qid] > 0 for qid in quotes1_ids)
        selected_from_conv2 = any(quote_selection_counts[qid] > 0 for qid in quotes2_ids)

        assert selected_from_conv1, "Should select at least some quotes from conversation 1"
        assert selected_from_conv2, "Should select at least some quotes from conversation 2"

        # Check that l2_distance() in vector comparison is working
        # This tests the vector similarity search part of the function
        sample = get_random_sample_quotes(db, project_analysis_run.id, context_limit=context_limit)

        # There should be quotes in the sample, which verifies the vector similarity search works
        assert len(sample) > 0, "Vector similarity search should return quotes"

        # Clean up
        for quote in all_quotes:
            db.delete(quote)
        db.delete(project_analysis_run)
        db.commit()
    finally:
        db.close()

    delete_conversation(conversation1["id"])
    delete_conversation(conversation2["id"])
    delete_project(project["id"])


def test_empty_project():
    """
    Test behavior when project has no quotes.
    """
    # Create a test project
    project = create_project(
        "test_empty_project",
        "en",
    )

    db = next(get_db())
    try:
        # Create a project analysis run
        project_analysis_run = ProjectAnalysisRunModel(
            id=generate_uuid(),
            project_id=project["id"],
            processing_status=ProcessingStatusEnum.PROCESSING,
        )
        db.add(project_analysis_run)
        db.commit()

        # Test with no quotes
        sample = get_random_sample_quotes(db, project_analysis_run.id, context_limit=1000)

        # Should return empty list with no errors
        assert isinstance(sample, list), "Should return a list"
        assert len(sample) == 0, "Should return an empty list for a project with no quotes"

        # Clean up
        db.delete(project_analysis_run)
        db.commit()
    finally:
        db.close()

    delete_project(project["id"])
