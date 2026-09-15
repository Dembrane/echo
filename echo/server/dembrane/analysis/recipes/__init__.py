"""The built-in recipes. The registry imports this package lazily, the first
time a recipe is looked up, and importing it registers each of them."""

from dembrane.analysis.recipes import tensions, arguments, deduplication
from dembrane.analysis.registry import register_recipe

for _recipe in (arguments.RECIPE, deduplication.RECIPE, tensions.RECIPE):
    register_recipe(_recipe, replace=True)
