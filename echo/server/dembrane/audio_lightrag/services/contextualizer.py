import asyncio
import logging
from typing import Dict

from dembrane.audio_lightrag.utils.litellm_utils import llm_model_func

logger = logging.getLogger(__name__)


class ConversationContextualizer:
    """
    Rich contextualization of conversation transcripts using Claude.
    
    THE PIVOT: Uses existing transcripts (no audio processing!).
    """
    
    async def contextualize(
        self,
        transcript: str,
        project_context: Dict[str, str],
    ) -> str:
        """
        Contextualize a conversation transcript with project information.
        
        Args:
            transcript: Full conversation transcript (concatenated from chunks)
            project_context: Dict with keys:
                - name: Project name
                - context: Project description
                - language: Project language
        
        Returns:
            Contextualized transcript for RAG insertion
        """
        
        if not transcript or not transcript.strip():
            logger.warning("Empty transcript provided, returning as-is")
            return transcript
        
        try:
            # Build the contextualization prompt
            prompt = self._build_prompt(transcript, project_context)
            
            # Call Claude via llm_model_func (LightRAG-compatible interface)
            logger.info(f"Calling Claude for contextualization (transcript length: {len(transcript)} chars)")
            contextual_transcript = await asyncio.to_thread(
                llm_model_func,
                prompt=prompt,
                system_prompt="You are an expert conversation analyst for deliberation research.",
                temperature=0.3,
            )
            
            logger.info(f"Contextualization successful (output length: {len(contextual_transcript)} chars)")
            return contextual_transcript
            
        except Exception as e:
            logger.error(f"Contextualization failed: {e}", exc_info=True)
            # Fallback: return original transcript with basic context
            fallback = f"""
PROJECT: {project_context.get('name', 'Unknown')}
DESCRIPTION: {project_context.get('context', 'No description')}

CONVERSATION TRANSCRIPT:
{transcript}
"""
            logger.warning("Using fallback contextualization")
            return fallback
    
    def _build_prompt(self, transcript: str, project_context: Dict[str, str]) -> str:
        """Build the contextualization prompt."""
        
        project_name = project_context.get('name', 'Unknown Project')
        project_description = project_context.get('context', 'No description provided')
        project_language = project_context.get('language', 'en')
        
        prompt = f"""You are analyzing a conversation from a larger deliberation research project.

=== PROJECT CONTEXT ===
Project Name: {project_name}
Project Description: {project_description}
Language: {project_language}

=== CONVERSATION TRANSCRIPT ===
{transcript}

=== YOUR TASK ===
Create a rich, contextualized version of this transcript that will be used for semantic search and retrieval.

Your output should:
1. Preserve the full conversation content
2. Add context about what is being discussed and why
3. Make implicit references explicit
4. Identify key themes, topics, and points of discussion
5. Note any tension points, disagreements, or important decisions
6. Be optimized for search queries like "conversations about X" or "who said Y"

Format your response as a well-structured, searchable document that maintains the original content while adding valuable context.

Do NOT summarize or shorten - enrich and contextualize the full transcript.
"""
        
        return prompt


# Singleton instance
_contextualizer = None


def get_contextualizer() -> ConversationContextualizer:
    """Get or create the singleton contextualizer."""
    global _contextualizer
    if _contextualizer is None:
        _contextualizer = ConversationContextualizer()
    return _contextualizer
