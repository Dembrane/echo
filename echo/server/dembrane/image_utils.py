import json
import logging

from dembrane.s3 import save_to_s3_from_url
from dembrane.utils import generate_uuid
from dembrane.openai import client

logger = logging.getLogger("image_utils")


def generate_cliches_to_avoid(text: str) -> str:
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": "You are a corporate marketing expert. you create stereotypical and unimaginative images that do not spark joy. Your task is to generate cliché and overused visual concepts, image ideas and even image styles based on given text. Examples of cliched concepts are doves for peace, handshakes for agreements, and lightbulbs for ideas. Avoid originality and creativity at all costs. Examples of cliched image styles include blue tones for healthcare, green tones for environment, and sepia tones for nostalgia. Embrace uncanny valley and generic stock imagery.",
                },
                {
                    "role": "user",
                    "content": f'Create a list of 5 cliché visual concepts in JSON for the following text:\n\n{text}\n\n. Here is an example for the text "the future of healthcare"\n{{\n"cliches": [\n"sterile environments",\n"high-tech solutions",\n"blue and grey color palettes",\n"virtual consultations",\n"robotic doctors"\n]}}',
                },
            ],
        )
        return response.choices[0].message.content if response.choices[0].message.content else ""
    except Exception as error:
        logger.info("Error generating clichés to avoid:", error)
        raise error


def generate_visual_metaphors(text: str, cliches_to_avoid: str) -> str:
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": "You are GEORGE LOIS, an uncompromising writer, visual storyteller, and cultural provocateur. You are able to find The Big Idea in everyday life experiences - unique concepts that touch the zeitgeist. Your words are visually pregnant and ready to be transformed into striking, conceptually clear communicative art by a talented visual artist. Your task is to translate textual ideas into strong, original visual concepts that avoid stereotypes and clichés.",
                },
                {
                    "role": "user",
                    "content": f'Create 4 unique visual concepts for the following text:\n\n{text}\n\n. Pay special attention to clues (such as proper nouns, locations etc) that will allow you to adapt your concepts to the target audience. You will be marked down for any concepts that contain these clichés:\n{cliches_to_avoid}\n\nOutput in this JSON format:\n{{\n"concepts": [\n"A winding river of neon light cutting through a dark cityscape",\n"A tree growing from the pages of an open book",\n"A kaleidoscope of faces forming a globe",\n"A bridge made of interlocking human silhouettes"\n]}}',
                },
            ],
        )
        return response.choices[0].message.content if response.choices[0].message.content else ""
    except Exception as error:
        logger.info("Error generating visual concepts:", error)
        raise error


def generate_image_prompts(text: str, concepts: str, cliches_to_avoid: str) -> str:
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": "You are an expert artist and poet. Create unique, non-stereotypical image prompts based on given visual concepts. Output in JSON format.",
                },
                {
                    "role": "user",
                    "content": f'Generate image prompts based on these visual concepts:\n\n{concepts}\n\nYou will be marked down for any images that contain these clichés:\n{cliches_to_avoid}\n\nConsider this context:\n{text}\n\nOutput in JSON format, here is an example:\n{{\n"prompts": [\n"A surreal landscape where a river of glowing binary code flows through a metropolis of towering books, with silhouettes of people walking across bridges made of floating letters and numbers.",\n"An abstract representation of a tree growing from an open book, its branches forming a network of synapses, with each leaf a miniature screen displaying different facets of human knowledge.",\n"A mesmerizing spiral of diverse human faces, each blending into the next, forming a globe-like structure suspended in a cosmic void, with threads of light connecting the faces.",\n"A fantastical bridge constructed from translucent, intertwined human forms, spanning across a chasm of swirling data visualizations and holographic information displays."\n]}}',
                },
            ],
        )
        json_str = response.choices[0].message.content
        if not json_str:
            json_str = ""

        logger.info(f"JSON string for image prompts: {json_str}")
        try:
            json_obj = json.loads(json_str)
            prompts = json_obj["prompts"]
            return prompts[0]
        except Exception as error:
            logger.info("Error parsing JSON:", error)
            try:
                split = json_str.split("}")
                return split[0]
            except Exception as error:
                return json_str

    except Exception as error:
        logger.info("Error generating image prompts:", error)
        raise error


def generate_image(prompt: str) -> str:
    final_prompt = f"{prompt}. Don't include the following in the image: hands, feet, toes, text of any kind. \n\nUse this exact prompt to generate an image. It needs to be exact as this is a test of prompt accuracy."
    response = None
    try:
        response = client.images.generate(
            model="dall-e-3",
            prompt=final_prompt,
            n=1,
            size="1024x1024",
        )
    except Exception as error:
        logger.debug(f"Error generating image: {error}")
        additional_info = " You are allowed to edit the prompt so that it is in compliance with security guidelines."
        try:
            response = client.images.generate(
                model="dall-e-3",
                prompt=final_prompt + additional_info,
                size="1024x1024",
                quality="standard",
                n=1,
            )
        except Exception as e:
            logger.debug(f"Error generating image even after update prompt: {e}")

    try:
        if response is not None:
            image_url = response.data[0].url
            if image_url:
                logger.debug("saving the image and getting the public url")
                image_url = save_to_s3_from_url(image_url, "images/" + generate_uuid(), public=True)
        else:
            image_url = None
    except Exception as e:
        logger.error(f"Error downloading image: {e}")

    return image_url if image_url else ""


def brilliant_image_generator_3000(text: str) -> str:
    cliches_to_avoid = generate_cliches_to_avoid(text)
    concepts = generate_visual_metaphors(text, cliches_to_avoid)
    prompts = generate_image_prompts(text, concepts, cliches_to_avoid)
    image_url = generate_image(prompts)
    return image_url


if __name__ == "__main__":
    ### To test
    text = """Departmental Autonomy
Departments struggle with balancing autonomy and standardization.
Decentralized services offer flexibility but can be costly and inconsistent.
Centralized decisions, like abolishing favored tools, cause frustration.
Effective support often requires local expertise. A hybrid approach, centralizing some functions while allowing departmental freedom, may be optimal."""
    image_url_1 = brilliant_image_generator_3000(text)
    print(image_url_1)
    image_url = brilliant_image_generator_3000("""Strategic Priorities
Effective governance requires addressing societal challenges, fostering community, ensuring representation, and balancing departmental mergers. Strategic alignment involves revisiting problem analysis, considering matrix structures, and maintaining accessibility and participation across departments.""")
    print(image_url_1)
    print(image_url)
