# Commented out to exclude trankit + torch dependencies
# import logging

# from dembrane.config import DISABLE_REDACTION

# #  ,TRANKIT_CACHE_DIR

# logger = logging.getLogger("ner")

# if not DISABLE_REDACTION:
#     logger.info("Loading NER model")
#     from trankit import Pipeline

#     p = Pipeline(
#         "english",
#         #  embedding="xlm-roberta-large",
#         # cache_dir=TRANKIT_CACHE_DIR,
#         gpu=False,
#     )
#     p.add("dutch")

#     # use langid to switch to the correct language
#     p.set_auto(True)
# else:
#     logger.info("NER redaction pipeline is disabled")


# def anonymize_sentence(sentence: str) -> str:
#     if DISABLE_REDACTION:
#         return sentence

#     tagged_sent = p.ner(sentence, is_sent=True)
#     text = tagged_sent["text"]
#     tokens = tagged_sent["tokens"]
#     redacted_text = text
#     offset = 0

#     for token in tokens:
#         logger.info(token)
#         if token["ner"] != "O":  # anything other than "O" - Other
#             start, end = token["span"]
#             # TODO: ignore if whitelisted
#             redacted_replacement = f"[REDACTED ({token['ner']})]"
#             redacted_text = (
#                 redacted_text[: start + offset]
#                 + redacted_replacement
#                 + redacted_text[end + offset :]
#             )
#             offset += len(redacted_replacement) - (end - start)

#     return redacted_text


# if __name__ == "__main__":
#     check = ["test sentence. my name is john doe."]

#     for s in check:
#         logger.info(anonymize_sentence(s))
