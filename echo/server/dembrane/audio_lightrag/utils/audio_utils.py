import os
import base64
import logging
from io import BytesIO

from pydub import AudioSegment

from dembrane.s3 import save_audio_to_s3, get_stream_from_s3, get_file_size_from_s3_mb
from dembrane.directus import directus, create_directus_segment, delete_directus_segment


def get_audio_file_size(path: str) -> float:
    size_mb = os.path.getsize(path) / (1024 * 1024)  # Convert bytes to MB
    return size_mb


def convert_to_wav(input_filepath: str, output_filepath: str | None = None) -> str | None:
    # TODO: Check if the file is already a WAV file

    if output_filepath == None:
        output_filepath = ".".join(input_filepath.split(".")[:-1]) + ".wav"
    try:
        audio = AudioSegment.from_file(input_filepath)
        audio.export(output_filepath, format="wav")
        os.remove(input_filepath)  # Remove the original file after conversion
        return output_filepath
    except Exception as e:
        logging.error(f"Error converting file to WAV: {e}")
        return None


def wav_to_str(wav_file_path: str) -> str:
    with open(wav_file_path, "rb") as file:
        return base64.b64encode(file.read()).decode("utf-8")
    

def process_ogg_files(
    unprocessed_chunk_file_uri_li: list[str],
    max_size_mb: float, configid: str, counter: int, 
) -> tuple[list[str], list[tuple[str, str]], int]:
    """
    Creates segments from chunks in ogg format. 
    A segment is maximum mb permitted in the model being used.
    Ensures all files are segmented close to max_size_mb.
    **** File might be a little larger than max limit
    Returns:
        unprocessed_chunk_file_uri_li: list[str]:
            List of unprocessed chunk file uris
        chunk_id_2_segment: list[tuple[str, str]]:
            List of chunk ids and segment ids
        counter: int:
            Counter for the next segment id
    """
    chunk_size_dict = {uri.split('/')[-1][37:73]:get_file_size_from_s3_mb(uri) 
     for uri in unprocessed_chunk_file_uri_li}
    chunk_id_2_uri = {uri.split('/')[-1][37:73]:uri 
                      for uri in unprocessed_chunk_file_uri_li}
    first_chunk_id = list(chunk_size_dict.keys())[0]
    chunk_id_2_segment = []
    segment_2_path = {}
    if chunk_size_dict[first_chunk_id] > max_size_mb:
        n_sub_chunks = int((chunk_size_dict[first_chunk_id] // max_size_mb) + 1)
        audio_stream = get_stream_from_s3(chunk_id_2_uri[first_chunk_id])
        audio = AudioSegment.from_file(BytesIO(audio_stream.read()), format="ogg")
        chunk_length = len(audio) // n_sub_chunks
        for i in range(n_sub_chunks):
            segment_id = create_directus_segment(configid, counter)
            chunk_id_2_segment.append((first_chunk_id, segment_id))
            start_time = i * chunk_length
            end_time = (i + 1) * chunk_length if i != n_sub_chunks - 1 else len(audio)
            chunk = audio[start_time:end_time]
            segment_uri = save_audio_to_s3(chunk, str(segment_id) + ".wav", public=False)
            directus.update_item(
                "conversation_segment",
                item_id=segment_id,
                item_data={"path": segment_uri},
            )
            segment_2_path[segment_id] = segment_uri
            counter += 1
        return unprocessed_chunk_file_uri_li[1:], chunk_id_2_segment, counter
    else:
        processed_chunk_li = []
        combined_size = 0
        combined_audio = AudioSegment.empty()
        segment_id = create_directus_segment(configid, counter)
        for first_chunk_id,size in chunk_size_dict.items():
            combined_size = combined_size + size # type: ignore
            if combined_size<= max_size_mb:
                chunk_id_2_segment.append((first_chunk_id, segment_id))
                audio_stream = get_stream_from_s3(chunk_id_2_uri[first_chunk_id])
                audio = AudioSegment.from_file(BytesIO(audio_stream.read()), format="ogg")
                processed_chunk_li.append(first_chunk_id)
                combined_audio += audio
        segment_uri = save_audio_to_s3(combined_audio, str(segment_id) + ".wav", public=False)
        segment_2_path[segment_id] = segment_uri
        directus.update_item(
            "conversation_segment",
            item_id=segment_id,
            item_data={"path": segment_uri},
        )
        counter += 1
        return  unprocessed_chunk_file_uri_li[len(processed_chunk_li):], chunk_id_2_segment, counter
    
def ogg_to_str(ogg_file_path: str) -> str:
    with open(ogg_file_path, "rb") as file:
        return base64.b64encode(file.read()).decode("utf-8")
