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

import logging
from typing import Any
from pathlib import Path
from collections import defaultdict

from jinja2 import BaseLoader, DictLoader, Environment, FileSystemLoader, select_autoescape

from dembrane.settings import get_settings

settings = get_settings()
PROMPT_TEMPLATES_DIR = settings.prompt_templates_dir

logger = logging.getLogger("prompts")

prompt_templates_path = Path(PROMPT_TEMPLATES_DIR)
prompt_loader: BaseLoader

if prompt_templates_path.exists() and prompt_templates_path.is_dir():
    prompt_loader = FileSystemLoader(prompt_templates_path)
    prompt_template_names = [
        entry.name
        for entry in prompt_templates_path.iterdir()
        if entry.is_file() and entry.name.endswith(".jinja")
    ]
else:
    logger.warning(
        "Prompt templates directory %s not found; continuing with empty template set",
        prompt_templates_path,
    )
    prompt_loader = DictLoader({})
    prompt_template_names = []

prompt_env = Environment(loader=prompt_loader, autoescape=select_autoescape())

# Load all the files from PROMPT_TEMPLATES_DIR that end with .jinja
PROMPT_TEMPLATE_LIST = prompt_template_names

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
