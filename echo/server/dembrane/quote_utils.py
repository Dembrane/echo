import re
import json
import random
import logging
from typing import List, Optional

import numpy as np
import pandas as pd
import tiktoken
from pydantic import BaseModel
from sqlalchemy import func, select, literal
from sqlalchemy.orm import Session
from sklearn.cluster import KMeans
from langchain_openai import OpenAIEmbeddings
from pgvector.sqlalchemy import Vector
from langchain_experimental.text_splitter import SemanticChunker

from dembrane.s3 import save_to_s3_from_url
from dembrane.ner import anonymize_sentence
from dembrane.utils import generate_uuid, get_utc_timestamp
from dembrane.openai import client
from dembrane.prompts import render_prompt
from dembrane.database import (
    ViewModel,
    QuoteModel,
    AspectModel,
    InsightModel,
    ConversationModel,
    ProcessingStatusEnum,
    ConversationChunkModel,
)
from dembrane.anthropic import count_tokens_anthropic
from dembrane.embedding import EMBEDDING_DIM, embed_text
from dembrane.image_utils import brilliant_image_generator_3000

logger = logging.getLogger("quote_utils")

np.random.seed(0)


lc_embedder = OpenAIEmbeddings(model="text-embedding-3-small")
semantic_chunker = SemanticChunker(lc_embedder)

SENTENCE_ENDING_PUNCTUATION = {".", "!", "?"}
SENTENCE_ENDING_PUNTUATION_REGEX = r"(?<=[.!?]) +"


def ends_with_punctuation(s: str) -> bool:
    if not s:
        return False
    return s.strip()[-1] in SENTENCE_ENDING_PUNCTUATION


def clean_ellipsis(text: str) -> str:
    return text.replace("...", "").replace("…", "")


def join_transcript_chunks(string_list: List[str]) -> str:
    cleaned_chunks = [clean_ellipsis(chunk).strip() for chunk in string_list]
    joined_string = cleaned_chunks[0]

    if len(cleaned_chunks) == 1:
        return joined_string

    for chunk in cleaned_chunks[1:]:
        if chunk == "":
            continue
        if ends_with_punctuation(joined_string):
            joined_string += " " + chunk
        else:
            joined_string += ". " + chunk

    return joined_string


# def generate_contextual_quote_and_embedding(db: Session, conversation_id: str, text: str) -> Tuple[QuoteModel, List[float]]:


def llm_split_text(text: str) -> List[str]:
    logger = logging.getLogger("llm_split_text")
    logger.debug(f"splitting text: {text}")
    messages = [
        {
            "role": "user",
            "content": 'Split the following text into 2 meaningful sentences. Retain the exact wording. Response format: <Sentence1>\\n<Sentence2>. Do not enclose your response in quotes or other special characters. Only output text.\n\n"""'
            + text
            + '\n"""',
        }
    ]

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,  # type: ignore
    )
    logger.debug(response)

    split_text = response.choices[0].message.content
    logger.debug(split_text)

    assert split_text is not None

    return split_text.split("\n")


MERGE_SENTENCE_LOWER_WORD_LIMIT = 8
MERGE_SENTENCE_UPPER_WORD_LIMIT = 45
BACKWARD_MERGE_UPPER_WORD_LIMIT = 35
LONG_SENTENCE_LIMIT = 75


# TODO: for a quote we should know which conversation_chunk it belongs to
def generate_quotes(
    db: Session, project_analysis_run_id: Optional[str], conversation_id: str
) -> List[QuoteModel]:
    """Generate quotes"""
    logger = logging.getLogger("generate_quotes")

    count_chunks = (
        db.query(ConversationChunkModel)
        .filter(
            ConversationChunkModel.conversation_id == conversation_id,
            ConversationChunkModel.transcript.is_not(None),
        )
        .count()
    )

    chunks = (
        db.query(ConversationChunkModel)
        .filter(
            ConversationChunkModel.conversation_id == conversation_id,
            ConversationChunkModel.transcript.is_not(None),
        )
        .order_by(ConversationChunkModel.created_at.asc())
        .all()
    )

    if len(chunks) < count_chunks:
        logger.warning(
            f"POSSIBLE BAD QUERY: the number of chunks found ({len(chunks)}) is less than the number of chunks in the conversation ({count_chunks})"
        )

    chunk_id_text = dict()

    for chunk in chunks:
        chunk_id_text[chunk.id] = chunk.transcript

    logger.debug(f"chunks found: {len(chunks)}")

    if len(chunks) == 0:
        logger.debug(f"no conversation_chunks found for conversation {conversation_id}")
        return []

    conversation_transcript = join_transcript_chunks(
        [anonymize_sentence(chunk.transcript) for chunk in chunks]
    )

    split_conversation_transcript = re.split(
        SENTENCE_ENDING_PUNTUATION_REGEX, conversation_transcript
    )

    logger.debug(
        f"after joining chunks and splitting into sentences: {len(split_conversation_transcript)} sentences"
    )

    quote_strs = []
    buffer: List[str] = []
    timestamp = 0

    # forward pass
    for sentence in split_conversation_transcript:
        if len(sentence.split()) < MERGE_SENTENCE_LOWER_WORD_LIMIT and buffer:
            buffer[-1] += " " + sentence
        else:
            buffer.append(sentence)

        current_quote = " ".join(buffer).strip()
        if len(current_quote.split()) > MERGE_SENTENCE_UPPER_WORD_LIMIT:
            if len(current_quote.split()) > LONG_SENTENCE_LIMIT:
                split_quotes = llm_split_text(current_quote)
                for split_quote in split_quotes:
                    quote_strs.append((split_quote, timestamp))
                    timestamp += 1
            else:
                quote_strs.append((current_quote, timestamp))
                timestamp += 1
            buffer = []

    if buffer:
        quote_strs.append((" ".join(buffer).strip(), timestamp))
        timestamp += 1

    # backward pass
    final_quotes = []
    i = len(quote_strs) - 1

    while i >= 0:
        if (
            i > 0
            and len(quote_strs[i][0].split()) + len(quote_strs[i - 1][0].split())
            <= BACKWARD_MERGE_UPPER_WORD_LIMIT
        ):
            merged_quote = quote_strs[i - 1][0] + " " + quote_strs[i][0]
            if len(merged_quote.split()) <= LONG_SENTENCE_LIMIT:
                final_quotes.append((merged_quote, quote_strs[i - 1][1]))
                i -= 2
            else:
                final_quotes.append(quote_strs[i])
                i -= 1
        else:
            final_quotes.append(quote_strs[i])
            i -= 1

    final_quotes.reverse()

    quotes = []

    for quote_str, quote_timestamp in final_quotes:
        try:
            closest_chunk_id = None

            for chunk_id, chunk_text in chunk_id_text.items():
                if quote_str in chunk_text:
                    closest_chunk_id = chunk_id
                    break

            closest_chunk = db.query(ConversationChunkModel).filter_by(id=closest_chunk_id).first()
            logger.debug(f"closest_chunk: {closest_chunk}")

            quote = QuoteModel(
                id=generate_uuid(),
                created_at=get_utc_timestamp(),
                project_analysis_run_id=project_analysis_run_id
                if project_analysis_run_id
                else None,
                conversation_id=conversation_id,
                text=quote_str,
                embedding=embed_text(quote_str),
                timestamp=closest_chunk.timestamp if closest_chunk else None,
                order=quote_timestamp,
            )

            quotes.append(quote)

        except Exception as e:
            logger.error(f"Error creating quote for text {quote_str}: {str(e)}")
            continue

    # Bulk insert all quotes at once
    db.bulk_save_objects(quotes)
    db.commit()

    return quotes


encoding = tiktoken.encoding_for_model("gpt-4o")


def count_tokens(text: str, provider: str = "openai") -> int:
    if provider == "anthropic":
        return count_tokens_anthropic(text)

    return len(encoding.encode(text))


# TODO: fix the sampling algo
def get_random_sample_quotes(
    db: Session, project_analysis_run_id: str, context_limit: int = 100000, batch_size: int = 1000
) -> List[QuoteModel]:
    """
    Generate a random sample of quotes for a given project and project analysis run, avoiding frequency bias.

    Args:
    - session: SQLAlchemy session for database access.
    - project_analysis_run_id: The ID of the project analysis run.
    - context_limit: The token limit for the context (default is 100000).
    - batch_size: The size of batches to fetch quotes in (default is 1000).

    Returns:
    - A list of randomly selected QuoteModel objects.
    """

    # TODO: context_limit needs to be divided by 2
    # https://community.openai.com/t/whats-the-new-tokenization-algorithm-for-gpt-4o/746708
    # OpenAIError('Error code: 400 - {\'error\': {\'message\': "This model\'s maximum context length is 128000 tokens. However, your messages resulted in 201901 tokens (including 92 in the response_format schemas.). Please reduce the length of the messages or schemas.", \'type\': \'invalid_request_error\', \'param\': \'messages\', \'code\': \'context_length_exceeded\'}}')
    # I got this error when I was trying to get 100000 tokens
    # when i counted the tokens, it was 100734, on openai end it was 201901
    # so i decided to divide the context_limit by 2, let's try this for now

    context_limit = context_limit // 2

    logger.debug(f"Getting random sample quotes for project analysis run {project_analysis_run_id}")

    # Initialize tracking variables at the start
    selected_quotes = []
    current_context_length = 0

    # Step 1: Select quotes ensuring at least one quote per conversation
    conversation_ids = db.scalars(
        select(QuoteModel.conversation_id)
        .filter_by(project_analysis_run_id=project_analysis_run_id)
        .distinct()
    ).all()

    for conv_id in conversation_ids:
        conv_quote = db.scalars(
            select(QuoteModel)
            .filter_by(conversation_id=conv_id, project_analysis_run_id=project_analysis_run_id)
            .order_by(func.random())
            .limit(1)
        ).first()
        if conv_quote:
            additional_length = count_tokens(conv_quote.text)
            if current_context_length + additional_length <= context_limit:
                selected_quotes.append(conv_quote)
                current_context_length += additional_length
            if current_context_length >= context_limit:
                break

    # Step 2: Fetch quotes in batches to avoid loading all quotes into memory
    offset = 0
    all_quotes: List[QuoteModel] = []
    while True:
        batch_quotes = db.scalars(
            select(QuoteModel)
            .filter_by(project_analysis_run_id=project_analysis_run_id)
            .offset(offset)
            .limit(batch_size)
        ).all()
        if not batch_quotes:
            break
        all_quotes.extend(batch_quotes)
        offset += batch_size

    # Step 3: Random vectors selection with context limit
    avg_quote_length_tokens = 60
    num_random_vectors = context_limit // avg_quote_length_tokens
    num_random_vectors = min(num_random_vectors, len(all_quotes))
    random_vectors = np.random.randn(num_random_vectors, EMBEDDING_DIM)

    for vector in random_vectors:
        # Convert the numpy array to a Python list for pgvector compatibility
        vector_as_list = vector.tolist()
        # Cast the list to a true pgvector type for proper operator binding
        vector_param = literal(vector_as_list, type_=Vector(EMBEDDING_DIM))

        # Skip the vector similarity search if no quotes are available
        if not all_quotes:
            continue

        try:
            # First try using the native pgvector operator
            closest_quote = db.scalars(
                select(QuoteModel)
                .filter(QuoteModel.project_analysis_run_id == project_analysis_run_id)
                .order_by(QuoteModel.embedding.l2_distance(vector_param))
                .limit(1)
            ).first()
        except Exception as e:
            logger.warning(f"Native pgvector operation failed: {e}")
            db.rollback()
            try:
                # Try using SQL function approach
                closest_quote = db.scalars(
                    select(QuoteModel)
                    .filter(QuoteModel.project_analysis_run_id == project_analysis_run_id)
                    .order_by(func.vector_l2_distance(QuoteModel.embedding, vector_param))
                    .limit(1)
                ).first()
            except Exception as e2:
                logger.warning(f"SQL function approach failed too: {e2}")
                db.rollback()
                # Fall back to random selection from the batch
                if all_quotes:
                    closest_quote = random.choice(all_quotes)
                else:
                    closest_quote = None

        if closest_quote and closest_quote not in selected_quotes:
            additional_length = count_tokens(closest_quote.text)
            if current_context_length + additional_length <= context_limit:
                selected_quotes.append(closest_quote)
                current_context_length += additional_length
            if current_context_length >= context_limit:
                break

    # Step 4: Add remaining random quotes while respecting context limit
    random.shuffle(all_quotes)
    for quote in all_quotes:
        if quote not in selected_quotes:
            additional_length = count_tokens(quote.text)
            if current_context_length + additional_length <= context_limit:
                selected_quotes.append(quote)
                current_context_length += additional_length
            if current_context_length >= context_limit:
                break

    return selected_quotes


def initialize_view(
    db: Session,
    project_analysis_run_id: str,
    user_input: str,
    initial_aspects: Optional[str] = None,
    language: str = "en",
) -> ViewModel:
    """
    Generate a list of draft aspects based on user input.

    Args:
    - db: Database session
    - project_analysis_run_id: ID of the project analysis run
    - user_input: The user's input about the analysis (e.g., "Sentiment")
    - initial_aspects: Optional initial aspects provided by the user
    - language: Language code for the prompt template (default: "en")

    Returns:
    - A ViewModel instance with generated aspects
    """
    logger = logging.getLogger("generate_draft_aspects")

    view = ViewModel(
        id=generate_uuid(),
        project_analysis_run_id=project_analysis_run_id,
        name=user_input,
        processing_status=ProcessingStatusEnum.PROCESSING,
        processing_message="Generating aspects",
        processing_started_at=get_utc_timestamp(),
    )
    db.add(view)
    db.commit()

    random_sample = get_random_sample_quotes(db, project_analysis_run_id)
    random_sample_quotes = "\n".join(['"' + quote.text + '"' for quote in random_sample])
    logger.debug(f"Random sample quotes: {len(random_sample_quotes)}")

    prompt = render_prompt(
        "initialize_view",
        language,
        {
            "user_input": user_input,
            "initial_aspects": initial_aspects,
            "random_sample_quotes": random_sample_quotes,
        },
    )

    messages = [{"role": "user", "content": prompt}]

    class AspectOutput(BaseModel):
        name: str
        description: str

    class JSONOutputSchema(BaseModel):
        aspect_list: list[AspectOutput]

    response = client.beta.chat.completions.parse(
        model="gpt-4o",
        messages=messages,  # type: ignore
        response_format=JSONOutputSchema,
    )

    response_message = response.choices[0].message

    try:
        if response_message.refusal is not None:
            raise ValueError(response_message.refusal)

        # Access the parsed response content
        parsed_response = response.choices[0].message.parsed
        logger.debug(f"Draft aspects: {parsed_response}")

        if parsed_response is None:
            raise ValueError("No response from GPT-4o")

        aspects_list = parsed_response.aspect_list
    except Exception as e:
        logger.error(f"Error generating draft aspects: {e}")
        raise e from e

    for aspect in aspects_list:
        if aspect.name is None or aspect.description is None:
            logger.warning(f"Aspect missing name or description: {aspect}")
            continue

        else:
            aspect = AspectModel(
                id=generate_uuid(),
                view_id=view.id,
                name=aspect.name,
                description=aspect.description,
            )
            db.add(aspect)
            db.commit()

    return view


def calculate_centroid(embeddings: List[List[float]]) -> List[float]:
    """
    Calculate the centroid of a list of embeddings.

    Args:
    - embeddings: A list of embedding vectors.

    Returns:
    - The centroid vector.
    """
    return np.mean(embeddings, axis=0).tolist()


def format_json_string_to_list(json_string: str) -> List[str]:
    # Handle the input JSON string
    sample_quotes_json_string = json_string if json_string else "[]"
    sample_quotes_json_string = sample_quotes_json_string.strip()

    # Log the last character for debugging purposes
    # logger.debug("Last character: {sample_quotes_json_string[-1] if sample_quotes_json_string else "Empty String"})

    # Ensure the string starts with '[' and ends with ']'
    if not sample_quotes_json_string.startswith("["):
        sample_quotes_json_string = "[" + sample_quotes_json_string

    if not sample_quotes_json_string.endswith("]"):
        if sample_quotes_json_string[-1] in [","]:
            sample_quotes_json_string = sample_quotes_json_string[:-1] + "]"
        elif sample_quotes_json_string[-1] in ['"', " ", "}"]:
            sample_quotes_json_string = sample_quotes_json_string + "]"
        else:
            sample_quotes_json_string = sample_quotes_json_string + '"]'

    # Attempt to parse the JSON string
    try:
        formatted_sample_quotes = json.loads(sample_quotes_json_string)
    except json.JSONDecodeError as e:
        logger.debug(f"Failed to parse the response as JSON: {e}")
        try:
            # split till the last ","
            sample_quotes_json_string = sample_quotes_json_string.rsplit(",", 1)[0] + "]"
            formatted_sample_quotes = json.loads(sample_quotes_json_string)
            logger.debug(f"Attempted to fix the JSON string: {formatted_sample_quotes}")
        except Exception as e:
            logger.debug(f"Failed to fix the JSON string: {e}")
            formatted_sample_quotes = []

    return formatted_sample_quotes


def assign_aspect_centroid(db: Session, aspect_id: str, language: str) -> None:
    aspect = db.get(AspectModel, aspect_id)

    if not aspect:
        logger.error(f"Aspect with ID {aspect_id} not found")
        return

    view = aspect.view

    if not view:
        logger.error(f"View not found for aspect {aspect_id}")
        return

    project_analysis_run_id = view.project_analysis_run_id

    if not project_analysis_run_id:
        logger.error(f"Project analysis run ID not found for view {view.id}")
        return

    sample_quotes = get_random_sample_quotes(db, project_analysis_run_id)
    sample_quotes_texts = [quote.text for quote in sample_quotes]
    random_sample_quotes = "\n".join([f'"{quote}"' for quote in sample_quotes_texts])

    logger.debug(f"trying for aspect: {aspect.name}")

    aspects = view.aspects
    if not aspects:
        logger.error(f"No aspects found for view {view.id}")
        return

    prompt = render_prompt(
        "assign_aspect_centroid",
        language,
        {
            "view_name": view.name,
            "aspect_name": aspect.name,
            "aspect_description": aspect.description,
            "other_aspects": ", ".join([a.name for a in aspects if a.id != aspect.id]),
            "random_sample_quotes": random_sample_quotes,
        },
    )

    messages = [{"role": "user", "content": prompt}]

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,  # type: ignore
    )

    sample_quotes_json_string = response.choices[0].message.content
    formatted_sample_quotes = format_json_string_to_list(
        sample_quotes_json_string if sample_quotes_json_string else "[]"
    )

    # gather representative quotes:
    representative_quote_ids = []
    for quote in sample_quotes:
        if any(
            re.search(re.escape(quote_text), quote.text, re.IGNORECASE)
            for quote_text in formatted_sample_quotes
        ):
            representative_quote_ids.append(quote.id)

    representative_quotes = (
        db.query(QuoteModel).filter(QuoteModel.id.in_(representative_quote_ids)).all()
    )

    logger.debug(f"Representative quotes for aspect {aspect.name}: {len(representative_quotes)}")

    aspect.representative_quotes = representative_quotes
    db.commit()

    # Calculate centroid using the returned sample quotes
    selected_quotes = [quote for quote in sample_quotes if quote.text in formatted_sample_quotes]

    logger.debug(f"Selected quotes for aspect {aspect.name}: {len(selected_quotes)}")

    if not selected_quotes:
        selected_quotes = [
            quote
            for quote in sample_quotes
            if any(
                re.search(re.escape(quote_text), quote.text, re.IGNORECASE)
                for quote_text in formatted_sample_quotes
            )
        ]

    embeddings_list = [
        embed_text(aspect.name + ". " + (aspect.description if aspect.description else ""))
    ]

    if selected_quotes:
        logger.debug(f"Quotes found for aspect {aspect.name}: {len(selected_quotes)}")
        embeddings_list.extend([quote.embedding for quote in selected_quotes])
    else:
        logger.debug(f"No quotes found for aspect {aspect.name}")

    centroid = calculate_centroid(embeddings_list)
    logger.debug(f"Setting centroid for aspect {aspect.name}")
    aspect.centroid_embedding = centroid
    db.commit()


def cluster_quotes_using_aspect_centroids(db: Session, view_id: str) -> None:
    view = db.get(ViewModel, view_id)

    if not view:
        logger.error(f"View with ID {view_id} not found")
        return

    aspects = view.aspects

    if not aspects:
        logger.error(f"No aspects found for view {view_id}")
        return

    quotes = (
        db.query(QuoteModel).filter_by(project_analysis_run_id=view.project_analysis_run_id).all()
    )

    # Assign each quote to the closest centroid
    aspect_centroids = {aspect.id: aspect.centroid_embedding for aspect in aspects}

    # Collect keys with None values in a separate list
    keys_to_delete = [k for k, v in aspect_centroids.items() if v is None]

    # Delete the collected keys after iteration
    for k in keys_to_delete:
        a = db.query(AspectModel).filter_by(id=k).first()
        if a:
            logger.debug(f"Removing aspect {a.name} from aspect_centroids because of None value")
        del aspect_centroids[k]

    for quote in quotes:
        # find the closest aspect ID by calculating the Euclidean distance between the quote embedding
        # and the centroids of different aspects using the min() function and the np.linalg.norm() function
        closest_aspect_id = min(
            aspect_centroids.keys(),
            key=lambda aspect_id: np.linalg.norm(
                np.array(quote.embedding) - np.array(aspect_centroids[aspect_id])
            ),
        )

        closest_aspect = (
            db.query(AspectModel)
            .filter_by(
                id=closest_aspect_id,
                view_id=view_id,
            )
            .first()
        )

        if closest_aspect:
            logger.debug(f"Closest aspect: {closest_aspect.name}")
            closest_aspect.quotes.append(quote)
            db.commit()
        else:
            logger.debug(f"No closest aspect found for quote {quote.id}")


def generate_aspect_summary(db: Session, aspect_id: str, language: str) -> None:
    aspect = db.query(AspectModel).filter_by(id=aspect_id).first()

    if not aspect:
        raise ValueError(f"Aspect with ID {aspect_id} not found")

    quotes = aspect.quotes
    representative_quotes = aspect.representative_quotes

    dedupe_quotes = list(set(representative_quotes + quotes))
    formatted_quotes = "\n".join([f'"{quote.text}"' for quote in dedupe_quotes])
    view_name = aspect.view.name if aspect.view else ""

    # Generate short summary
    prompt = render_prompt(
        "generate_aspect_short_summary",
        language,
        {
            "view_name": view_name,
            "aspect_name": aspect.name,
            "aspect_description": aspect.description,
            "formatted_quotes": formatted_quotes,
        },
    )

    messages = [{"role": "user", "content": prompt}]
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,  # type: ignore
    )

    short_summary = response.choices[0].message.content
    aspect.short_summary = short_summary
    db.commit()

    # Generate long summary
    prompt = render_prompt(
        "generate_aspect_long_summary",
        language,
        {
            "view_name": view_name,
            "aspect_name": aspect.name,
            "aspect_description": aspect.description,
            "short_summary": aspect.short_summary,
            "formatted_quotes": formatted_quotes,
        },
    )

    messages = [{"role": "user", "content": prompt}]
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,  # type: ignore
    )

    long_summary = response.choices[0].message.content
    aspect.long_summary = long_summary
    db.commit()

    return


def generate_aspect_image(db: Session, aspect_id: str) -> AspectModel:
    logger.debug(f"generating image for aspect: {aspect_id}")
    aspect = db.query(AspectModel).filter_by(id=aspect_id).first()

    if not aspect:
        raise ValueError(f"Aspect with ID {aspect_id} not found")

    response = None

    try:
        use_model = "MODEST"

        view = aspect.view
        if not view:
            raise ValueError("View not found")

        project_analysis_run = view.project_analysis_run
        if not project_analysis_run:
            raise ValueError("Project analysis run not found")

        project = project_analysis_run.project
        if not project:
            raise ValueError("Project not found")

        use_model = project.image_generation_model or "MODEST"

        logger.debug(f"using image generation model: {use_model}")

    except Exception as e:
        logger.error(f"Error getting image generation model: {e}")
        use_model = "MODEST"

    if use_model == "MODEST":
        try:
            prompt = render_prompt(
                "generate_aspect_image",
                "en",
                {
                    "aspect_name": aspect.name,
                    "aspect_description": aspect.description,
                },
            )

            response = client.images.generate(
                model="dall-e-3",
                prompt=prompt,
                size="1024x1024",
                quality="standard",
                n=1,
            )
        except Exception as e:
            logger.debug(f"Error generating image: {e}")
            additional_info = (
                "edit the prompt so that it is in compliance with security guidelines."
            )
            try:
                response = client.images.generate(
                    model="dall-e-3",
                    prompt=prompt + additional_info,
                    size="1024x1024",
                    quality="standard",
                    n=1,
                )
            except Exception as e:
                logger.debug(f"Error generating image even after update prompt: {e}")

        try:
            if response:
                image_url = response.data[0].url
                try:
                    image_extension = str(image_url).split(".")[-1].split("?")[0]
                except Exception as e:
                    logger.error(f"Error getting image extension: {e}")
                    image_extension = "png"

                if image_url:
                    logger.debug("saving the image and getting the public url")
                    image_url = save_to_s3_from_url(
                        image_url, "images/" + generate_uuid() + "." + image_extension, public=True
                    )
            else:
                image_url = None
        except Exception as e:
            logger.error(f"Error downloading image: {e}")
    elif use_model == "EXTRAVAGANT":
        image_url = brilliant_image_generator_3000(f"{aspect.name}\n{aspect.short_summary}")
    elif use_model == "PLACEHOLDER":
        image_url = None
    else:
        logger.info(f"Image generation model not found: {use_model}")
        image_url = None

    logger.debug(f"setting image URL to aspect: {image_url}")
    aspect.image_url = image_url

    db.commit()

    return aspect


def generate_aspect_extras(db: Session, aspect_id: str, language: str) -> AspectModel | None:
    """aspect summary, aspect image"""
    aspect = db.query(AspectModel).filter_by(id=aspect_id).first()

    if not aspect:
        logger.error(f"Aspect with ID {aspect_id} not found")
        return None

    generate_aspect_summary(db, aspect.id, language)
    generate_aspect_image(db, aspect.id)

    return aspect


def generate_view_extras(db: Session, view_id: str, language: str) -> ViewModel:
    """Generate view summary and aspect summaries."""
    view = db.query(ViewModel).filter_by(id=view_id).first()

    if not view:
        raise ValueError(f"View with ID {view_id} not found")

    formatted_aspects = "\n\n".join(
        [
            f"""\
<aspect>
Aspect: {aspect.name}
Description: {aspect.description}
Summary: {aspect.long_summary}
</aspect>"""
            for aspect in view.aspects
        ]
    )

    prompt = render_prompt(
        "generate_view_extras",
        language,
        {
            "view_name": view.name,
            "formatted_aspects": formatted_aspects,
        },
    )

    messages = [{"role": "user", "content": prompt}]

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,  # type: ignore
    )

    view.summary = response.choices[0].message.content
    db.commit()

    return view


def generate_insight_extras(db: Session, insight_id: str, language: str) -> None:
    """Generate insight extras for a given cluster."""
    insight = db.query(InsightModel).filter_by(id=insight_id).first()

    if not insight:
        logger.error(f"Insight with ID {insight_id} not found")
        return

    quotes = insight.quotes
    quote_text_joined = "\n".join([f'"{quote.text}"' for quote in quotes])

    # Generate title
    title_prompt = render_prompt(
        "generate_insight_title",
        language,
        {
            "quote_text_joined": quote_text_joined,
        },
    )

    title_messages = [{"role": "user", "content": title_prompt}]

    title_response = client.chat.completions.create(
        model="gpt-4o",
        messages=title_messages,  # type: ignore
    )

    if not title_response.choices:
        logger.error(f"No title response for insight {insight_id}")
        return

    title = title_response.choices[0].message.content

    # Generate summary
    summary_prompt = render_prompt(
        "generate_insight_summary",
        language,
        {
            "quote_text_joined": quote_text_joined,
            "title": title,
        },
    )

    summary_messages = [{"role": "user", "content": summary_prompt}]

    summary_response = client.chat.completions.create(
        model="gpt-4o",
        messages=summary_messages,  # type: ignore
    )

    summary = summary_response.choices[0].message.content

    insight.title = title
    insight.summary = summary
    db.commit()

    return


def generate_conversation_summary(db: Session, conversation_id: str, language: str) -> None:
    """Generate a summary for a conversation."""
    conversation = db.query(ConversationModel).filter_by(id=conversation_id).first()

    if not conversation:
        logger.error(f"Conversation with ID {conversation_id} not found")
        return

    quotes = (
        db.query(QuoteModel)
        .filter_by(conversation_id=conversation_id)
        .order_by(QuoteModel.timestamp)
        .all()
    )

    if not quotes:
        logger.error(f"No quotes found for conversation {conversation_id}")
        return

    quote_text_joined = "\n".join([f'"{quote.text}"' for quote in quotes])

    prompt = render_prompt(
        "generate_conversation_summary",
        language,
        {
            "quote_text_joined": quote_text_joined,
        },
    )

    messages = [{"role": "user", "content": prompt}]

    # FIXME: use litellm
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,  # type: ignore
    )

    conversation.summary = response.choices[0].message.content
    db.commit()

    return


def initialize_insights(db: Session, project_analysis_run_id: str) -> List[str]:
    """Generate insights"""

    quotes = (
        db.query(QuoteModel)
        .with_entities(QuoteModel.id, QuoteModel.embedding)
        .filter(QuoteModel.project_analysis_run_id == project_analysis_run_id)
        .all()
    )

    if not quotes:
        logger.error(f"No quotes found for project analysis run {project_analysis_run_id}")
        return []

    df = pd.DataFrame(
        [
            {
                "id": quote.id,
                "embedding": quote.embedding,
            }
            for quote in quotes
        ]
    )

    df["embedding"] = df.get("embedding").apply(lambda x: np.array(x))  # type: ignore
    matrix = np.vstack(df["embedding"].values)  # type: ignore

    logger.debug(f"matrix shape {matrix.shape}")

    n_clusters = len(quotes) // 4
    logger.debug(f"n_clusters, {n_clusters}")
    logger.debug(f"quotes, {len(quotes)}")

    kmeans = KMeans(n_clusters=n_clusters, init="k-means++")
    kmeans.fit(matrix)
    labels = kmeans.labels_
    df["Cluster"] = labels

    insight_ids = []

    for cluster_index in range(n_clusters):
        insight = InsightModel(
            id=generate_uuid(),
            project_analysis_run_id=project_analysis_run_id,
        )

        quote_ids = df[df.Cluster == cluster_index].id.values

        quotes_list = db.query(QuoteModel).filter(QuoteModel.id.in_(quote_ids)).all()
        insight.quotes.extend(quotes_list)

        insight_ids.append(insight.id)
        db.add(insight)
        db.commit()

    return insight_ids


# if __name__ == "__main__":
#     from dembrane.database import get_db

#     db = next(get_db())

# project_id = "f98d4ef2-1bc9-40f1-b360-3d784e2b22a0"

# analysis_id = "a27ad390-2f79-4db9-9f64-8e94abfc6fbc"

# quotes = get_random_sample_quotes(db, analysis_id)

# random_sample_quotes = "\n".join(['"' + quote.text + '"' for quote in quotes])

# print(count_tokens(random_sample_quotes))

# print(len(quotes))

# print("count - ",count_tokens(random_sample_quotes))


# project_analysis_run = ProjectAnalysisRunModel(
# id=generate_uuid(), project_id=project_id, processing_status="DONE"
# )

# db.add(project_analysis_run)
# db.commit()

# logger.debug(f"project_analysis_run_id: {project_analysis_run.id}")

# analysis_id = project_analysis_run.id

# generate_quotes(db, analysis_id, "a615ced7-fce1-4434-a88e-5041f30c2a15")

# conversations = db.query(ConversationModel).filter(ConversationModel.project_id == project_id).all()

# for conversation in conversations:
#     logger.debug(f"conversation_id: {conversation.id}")
#     quotes = generate_quotes(db, project_analysis_run.id, conversation.id)
#     logger.debug(f"quotes generated: {len(quotes)}")

# generate_aspect_image(db, "d9d4eb70-2965-4f68-911f-de7606ed0cf7")

# logger.debug("quotes are generated")

# view = generate_view(db, analysis_id, "Make a plan to restructure the TUE Governance", "Make it a detailed plan")
# assign_aspect_centroids_and_cluster_quotes(db, analysis_id, view.id)
# generate_view_extras(db, view.id)
# logger.debug(view.id)

# view = initialize_view(db, analysis_id, "Sentiment", "Use only 3")
# assign_aspect_centroids_and_cluster_quotes(db, analysis_id, view.id)

# aspects = view.aspects
# for aspect in aspects:
#     generate_aspect_extras(db, aspect.id)

# generate_view_extras(db, view.id)

# logger.debug(view.id)

# generate_insights(db, id)

# prompt = render_prompt(
#     "initialize_view",
#     "en",
#     {
#         "user_input": "Make a plan to restructure the TUE Governance",
#         "random_sample_quotes": "Hello World.",
#     },
# )

# messages = [{"role": "user", "content": prompt}]

# class AspectOutput(BaseModel):
#     name: str
#     description: str

# class JSONOutputSchema(BaseModel):
#     aspect_list: list[AspectOutput]

# # use beta...parse lol, took me a while to debug
# response = client.beta.chat.completions.parse(  # type: ignore
#     model="gpt-4o",
#     messages=messages,  # type: ignore
#     response_format=JSONOutputSchema,
# )

# response_message = response.choices[0].message

# try:
#     if response_message.refusal is not None:
#         raise ValueError(response_message.refusal)

#     # Access the parsed response content
#     parsed_response = response.choices[0].message.parsed
#     print(f"Draft aspects: {parsed_response}")

#     aspects_list = parsed_response.aspect_list
# except Exception as e:
#     print(f"Error generating draft aspects: {e}")
#     raise e from e
