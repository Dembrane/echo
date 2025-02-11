from flair.data import Sentence
from flair.models import SequenceTagger
from langdetect import detect

# Laad modellen en definieer talenlijst
language_models = [
    {"lang": "nl", "model": SequenceTagger.load("flair/ner-dutch-large"), "person_tag": "PER", "replacement": "[Persoon]"},
    {"lang": "en", "model": SequenceTagger.load("xlm-roberta-large"), "person_tag": "PER", "replacement": "[Person]"}
]

def anonymize_text(text):
    try:
        detected_lang = detect(text)
    except:
        detected_lang = "unknown"

    # Zoek het juiste model op basis van de taal
    tagger_info = next((lm for lm in language_models if lm["lang"] == detected_lang), None)

    if not tagger_info:
        return text  # Geen geschikt model gevonden

    tagger = tagger_info["model"]
    person_tag = tagger_info["person_tag"]
    replacement = tagger_info["replacement"]

    # Maak een Flair-zin en pas NER toe
    sentence = Sentence(text)
    tagger.predict(sentence)

    # Vervang persoonsnamen
    for entity in sentence.get_spans("ner"):
        if entity.tag == person_tag:
            text = text.replace(entity.text, replacement)

    return text

# Test het met een voorbeeld
test_text_nl = "Mark Rutte en Sigrid Kaag spraken over de formatie."
test_text_en = "Barack Obama met Joe Biden at the White House."

print(anonymize_text(test_text_nl))  # ("[Persoon] en [Persoon] spraken over de formatie.", 2)
print(anonymize_text(test_text_en))  # ("[Person] met [Person] at the White House.", 2)

# Later kun je eenvoudig meer talen toevoegen:
# language_models.append({"lang": "fr", "model": SequenceTagger.load("flair/ner-french"), "person_tag": "PER", "replacement": "[Personne]"})
