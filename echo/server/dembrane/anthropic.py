import json
from typing import Any, Dict, List, Optional, Generator

from anthropic import Anthropic, AsyncAnthropic

from dembrane.config import ANTHROPIC_API_KEY

anthropic_client = Anthropic(
    api_key=ANTHROPIC_API_KEY,
)

async_anthropic_client = AsyncAnthropic(
    api_key=ANTHROPIC_API_KEY,
)


def count_tokens_anthropic(text: str) -> int:
    return anthropic_client.beta.messages.count_tokens(
        model="claude-3-5-sonnet-20241022",
        messages=[{"role": "user", "content": text}],
    ).input_tokens


def stream_anthropic_chat_response(
    system: List[Dict[str, Any]], messages: List[Dict[str, Any]], protocol: str = "data"
) -> Generator[str, None, None]:
    """
    Generates response from Anthropic
    and returns openAI like stream response
    """
    stream = anthropic_client.messages.create(
        model="claude-3-5-sonnet-20241022",
        system=system,  # type:ignore
        messages=messages,  # type:ignore
        max_tokens=2048,
        stream=True,
    )

    finish_reason = "unknown"
    usage = {"promptTokens": 0, "completionTokens": 0}
    tool_call_content_blocks = {}

    for chunk in stream:
        if chunk.type == "ping":  # type:ignore
            continue

        elif chunk.type == "content_block_start":  # type:ignore
            if chunk.content_block.type == "text":  # type:ignore
                continue
            elif chunk.content_block.type == "tool_use":  # type:ignore
                tool_call_content_blocks[chunk.index] = {  # type:ignore
                    "tool_call_id": chunk.content_block.id,  # type:ignore
                    "tool_name": chunk.content_block.name,  # type:ignore
                    "json_text": "",
                }
                if protocol == "data":
                    yield f"b:{json.dumps({'toolCallId': chunk.content_block.id, 'toolName': chunk.content_block.name})}\n"  # type:ignore

        elif chunk.type == "content_block_stop":  # type:ignore
            if chunk.index in tool_call_content_blocks:  # type:ignore
                content_block = tool_call_content_blocks[chunk.index]  # type:ignore
                if protocol == "data":
                    yield f"9:{json.dumps({'toolCallId': content_block['tool_call_id'], 'toolName': content_block['tool_name'], 'args': json.loads(content_block['json_text'])})}\n"
                del tool_call_content_blocks[chunk.index]  # type:ignore

        elif chunk.type == "content_block_delta":  # type:ignore
            if chunk.delta.type == "text_delta":  # type:ignore
                if protocol == "text":
                    yield chunk.delta.text  # type:ignore
                elif protocol == "data":
                    yield f"0:{json.dumps(chunk.delta.text)}\n"  # type:ignore
            elif chunk.delta.type == "input_json_delta":  # type:ignore
                content_block = tool_call_content_blocks[chunk.index]  # type:ignore
                if protocol == "data":
                    yield f"c:{json.dumps({'toolCallId': content_block['tool_call_id'], 'argsTextDelta': chunk.delta.partial_json})}\n"  # type:ignore
                content_block["json_text"] += chunk.delta.partial_json  # type:ignore

        elif chunk.type == "message_start":  # type:ignore
            usage["promptTokens"] = chunk.message.usage.input_tokens  # type:ignore
            usage["completionTokens"] = chunk.message.usage.output_tokens  # type:ignore
            if protocol == "data":
                yield f"2:{json.dumps([{'id': chunk.message.id, 'modelId': chunk.message.model}])}\n"  # type:ignore

        elif chunk.type == "message_delta":  # type:ignore
            usage["completionTokens"] = chunk.usage.output_tokens  # type:ignore
            if chunk.delta.stop_reason:  # type:ignore
                finish_reason = map_anthropic_stop_reason(chunk.delta.stop_reason)  # type:ignore

        elif chunk.type == "message_stop":  # type:ignore
            if protocol == "data":
                yield f"d:{json.dumps({'finishReason': finish_reason, 'usage': usage})}\n"

        elif chunk.type == "error":  # type:ignore
            if protocol == "data":
                yield f"3:{json.dumps(chunk.error)}\n"  # type:ignore
            else:
                yield f"Error: {chunk.error}"  # type:ignore


def map_anthropic_stop_reason(finish_reason: Optional[str]) -> str:
    if finish_reason in ["end_turn", "stop_sequence"]:
        return "stop"
    elif finish_reason == "tool_use":
        return "tool-calls"
    elif finish_reason == "max_tokens":
        return "length"
    else:
        return "unknown"
