import json
import logging

from dembrane.prompts import render_prompt
from dembrane.audio_lightrag.utils.litellm_utils import llm_model_func

logger = logging.getLogger(__name__)


class ConversationContextualizer:
    """
    Rich contextualization of conversation transcripts using Claude.
    
    THE PIVOT: Uses existing transcripts (no audio processing!).
    Uses the same audio_model_system_prompt as old pipeline but skips transcription (Task 1).
    """
    
    async def contextualize(
        self,
        transcript: str,
        event_text: str,
        previous_conversation_text: str,
        language: str = "en",
    ) -> str:
        """
        Contextualize a conversation transcript with project information.
        
        Args:
            transcript: Full conversation transcript (concatenated from chunks)
            event_text: Project context formatted as key:value pairs
            previous_conversation_text: Previous contextual transcripts (empty for first segment)
            language: Language code (default: "en")
        
        Returns:
            Contextualized transcript for RAG insertion
        """
        
        if not transcript or not transcript.strip():
            logger.warning("Empty transcript provided, returning as-is")
            return transcript
        
        try:
            # Use the same prompt template as old audio pipeline
            # This ensures RAG output quality remains identical to before
            system_prompt = render_prompt(
                "audio_model_system_prompt",
                language,
                {
                    "event_text": event_text,
                    "previous_conversation_text": previous_conversation_text,
                }
            )
            
            # Build user prompt with transcript
            # Note: We skip Task 1 (transcription) since we already have transcripts
            # The LLM will focus on Task 2 (contextual analysis)
            user_prompt = f"""Here is the conversation transcript (already transcribed):

{transcript}

Please provide your CONTEXTUAL ANALYSIS (Task 2 from the system prompt).
Since the transcript is already provided, skip Task 1 and focus entirely on the detailed contextual analysis."""
            
            # Call Claude via llm_model_func (LightRAG-compatible interface)
            logger.info(f"Calling Claude for contextualization (transcript length: {len(transcript)} chars)")
            
            response = await llm_model_func(
                prompt=user_prompt,
                system_prompt=system_prompt,
                temperature=0.3,
            )
            
            # Parse JSON response to extract CONTEXTUAL_TRANSCRIPT
            # Old format: {"TRANSCRIPTS": [...], "CONTEXTUAL_TRANSCRIPT": "..."}
            try:
                parsed = json.loads(response)
                contextual_transcript = parsed.get("CONTEXTUAL_TRANSCRIPT", response)
            except json.JSONDecodeError:
                # If not valid JSON, use the full response as contextual transcript
                logger.warning("Response not in expected JSON format, using raw response")
                contextual_transcript = response
            
            logger.info(f"Contextualization successful (output length: {len(contextual_transcript)} chars)")
            return contextual_transcript
            
        except Exception as e:
            logger.error(f"Contextualization failed: {e}", exc_info=True)
            # Fallback: return original transcript
            logger.warning("Using fallback contextualization (original transcript)")
            return transcript


# Singleton instance
_contextualizer = None


def get_contextualizer() -> ConversationContextualizer:
    """Get or create the singleton contextualizer."""
    global _contextualizer
    if _contextualizer is None:
        _contextualizer = ConversationContextualizer()
    return _contextualizer
