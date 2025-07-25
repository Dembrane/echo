"""Prompt template rendering module.

This module provides functionality for loading and rendering Jinja2 templates
from a configured templates directory. Templates are automatically loaded from
PROMPT_TEMPLATES_DIR and must have the .jinja extension.

Example:
    >>> render_prompt("context-1.jinja", {"model": "gpt-4"})
    "You are a helpful AI assistant powered by gpt-4..."

Attributes:
    env (Environment): Jinja2 environment configured with the template directory
    PROMPT_TEMPLATE_LIST (list[str]): List of available template filenames
"""

import os
import json
import logging
from typing import Any, Optional
from collections import defaultdict

from jinja2 import Environment, FileSystemLoader, select_autoescape

from dembrane.config import JSON_TEMPLATES_DIR, PROMPT_TEMPLATES_DIR

logger = logging.getLogger("prompts")

prompt_env = Environment(
    loader=FileSystemLoader(PROMPT_TEMPLATES_DIR), autoescape=select_autoescape()
)

# Load all the files from PROMPT_TEMPLATES_DIR that end with .jinja
PROMPT_TEMPLATE_LIST = [
    f.name for f in os.scandir(PROMPT_TEMPLATES_DIR) if f.is_file() and f.name.endswith(".jinja")
]

# Create a dictionary to map template names to their supported languages
template_support = defaultdict(set)
for template_name in sorted(PROMPT_TEMPLATE_LIST):
    name, lang, _ = template_name.rsplit(".", 2)
    template_support[name].add(lang)

# Log the template support matrix
header = "Name                           | de  | en  | es  | fr  | nl"
separator = "-" * len(header)
rows = []
for name, languages in template_support.items():
    # Pad the name to 19 characters to align with header
    padded_name = f"{name[:30]}{' ' * (30 - len(name[:30]))}"
    row = f"{padded_name}| " + " | ".join(
        " y " if lang in languages else " n " for lang in ["de", "en", "es", "fr", "nl"]
    )
    rows.append(row)

logger.info(f"Loaded {len(rows)} prompt templates:\n{header}\n{separator}\n" + "\n".join(rows))


def render_prompt(prompt_name: str, language: str, kwargs: dict[str, Any]) -> str:
    """Render a prompt template with the given arguments.

    Args:
        prompt_name: Name of the prompt template file (without .jinja extension)
        language: ISO 639-1 language code of the prompt template file (example: "en", "nl", "fr", "es", "de". etc.)
        kwargs: Dictionary of arguments to pass to the template renderer

    Returns:
        The rendered prompt template as a string

    Raises:
        ValueError: If the prompt template is not found in PROMPT_TEMPLATES_DIR
    """
    logger.debug(f"Rendering prompt {prompt_name} with kwargs: {kwargs.keys()}")

    full_prompt_name = f"{prompt_name}.{language}.jinja"

    # Check if the prompt with the specified language exists
    if full_prompt_name not in PROMPT_TEMPLATE_LIST:
        # Try to use the .en version if available
        default_prompt_name = f"{prompt_name}.en.jinja"
        if default_prompt_name in PROMPT_TEMPLATE_LIST:
            logger.warning(
                f"Prompt template {full_prompt_name} not found, using default {default_prompt_name}"
            )
            full_prompt_name = default_prompt_name
        else:
            raise ValueError(
                f"Prompt template {full_prompt_name} not found and no default available"
            )

    template = prompt_env.get_template(full_prompt_name)
    return template.render(**kwargs)


JSON_TEMPLATE_LIST = [
    f.name for f in os.scandir(JSON_TEMPLATES_DIR) if f.is_file() and f.name.endswith(".jinja")
]

json_env = Environment(loader=FileSystemLoader(JSON_TEMPLATES_DIR), autoescape=select_autoescape())

for name in set(JSON_TEMPLATE_LIST):
    logger.info(f"JSON template {name} found in {JSON_TEMPLATES_DIR}")


def render_json(
    prompt_name: str,
    language: str,
    kwargs: dict[str, Any],
    # json keys to validate
    keys_to_validate: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Render a message template with the given arguments and return a dictionary object.

    Args:
        prompt_name: Name of the prompt template file (without .jinja extension)
        language: ISO 639-1 language code of the prompt template file (example: "en", "nl", "fr", "es", "de". etc.)
        kwargs: Dictionary of arguments to pass to the template renderer
        keys_to_validate: List of keys to validate in the message

    """
    if keys_to_validate is None:
        keys_to_validate = []
    full_json_template_name = f"{prompt_name}.{language}.jinja"
    if full_json_template_name not in JSON_TEMPLATE_LIST:
        default_json_template_name = f"{prompt_name}.en.jinja"
        if default_json_template_name in JSON_TEMPLATE_LIST:
            logger.warning(
                f"JSON template {full_json_template_name} not found, using default {default_json_template_name}."
            )
            full_json_template_name = default_json_template_name
        else:
            raise ValueError(
                f"JSON template {full_json_template_name} not found and no default available"
            )
    template = json_env.get_template(full_json_template_name)
    rendered_prompt = template.render(**kwargs)
    try:
        message = json.loads(rendered_prompt)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse JSON from rendered prompt: {rendered_prompt}")
        raise ValueError(f"Error: {e}") from e

    missing_keys = [key for key in keys_to_validate if key not in message]
    if missing_keys:
        raise ValueError(
            f"Missing keys in message: {missing_keys}. Please check the prompt template: {prompt_name}. \n"
            f"Message: {message}"
        )

    return message
