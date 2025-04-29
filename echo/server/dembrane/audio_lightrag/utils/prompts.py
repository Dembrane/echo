from dembrane.prompts import render_prompt


class Prompts:
    @staticmethod
    def audio_model_system_prompt(event_text: str, previous_conversation_text: str, language: str = "en") -> str:
        return render_prompt(
            "audio_model_system_prompt",
            language,
            {
                "event_text": event_text,
                "previous_conversation_text": previous_conversation_text,
            },
        )

    @staticmethod
    def text_structuring_model_system_prompt(language: str = "en") -> str:
        return render_prompt(
            "text_structuring_model_system_prompt",
            language,
            {}
        )