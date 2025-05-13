import io
import os
import base64
from io import BytesIO

import pandas as pd
from pydub import AudioSegment

from dembrane.s3 import (
    save_audio_to_s3,
    get_stream_from_s3,
)
from dembrane.directus import directus


def _read_mp3_from_s3_and_get_wav_file_size(uri: str, format: str = "mp3") -> float:
    """
    Calculate the size of an audio file stored in S3 when converted to WAV format.
    This is useful for estimating the memory usage when loading audio files for processing.
    
    Args:
        uri (str): The URI of the audio file in S3
        format (str): The format of the stored audio file (default: "mp3")
        
    Returns:
        float: The size of the audio in WAV format in MB
    """
    audio_stream = get_stream_from_s3(uri)
    
    try:
        # Load the audio file from S3 into an AudioSegment
        audio = AudioSegment.from_file(io.BytesIO(audio_stream.read()), format=format)
        
        # Export to WAV to calculate uncompressed size
        wav_buffer = io.BytesIO()
        audio.export(wav_buffer, format="wav")

        # Calculate size in MB
        wav_size_mb = len(wav_buffer.getvalue()) / (1024 * 1024)

        return wav_size_mb

    except Exception as e:
        raise e

def get_audio_file_size(path: str) -> float:
    size_mb = os.path.getsize(path) / (1024 * 1024)  # Convert bytes to MB
    return size_mb


def wav_to_str(wav_input: AudioSegment) -> str:
    buffer = BytesIO()
    wav_input.export(buffer, format="wav")
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def process_audio_files(
    unprocessed_chunk_file_uri_li: list[str],
    max_size_mb: float, configid: str, counter: int, 
    process_tracker_df: pd.DataFrame,
    format: str = "mp3"
) -> tuple[list[str], list[tuple[str, str]], int]:
    """
    Creates segments from chunks in ogg format. 
    A segment is maximum mb permitted in the model being used.
    Ensures all files are segmented close to max_size_mb.
    **** File might be a little larger than max_size_mb
    Args:
        unprocessed_chunk_file_uri_li (list[str]):
            List of unprocessed chunk file uris in order of processing
        max_size_mb (float):
            Maximum size of a segment in MB
        configid (str):
            The config id of the segment
        counter (int):
            The counter for the next segment id
        process_tracker_df (pd.DataFrame):
            The process tracker dataframe
        format (str):
            The format of the audio file
    Returns:
        unprocessed_chunk_file_uri_li: list[str]:
            List of unprocessed chunk file uris
        chunk_id_2_segment: list[tuple[str, str]]:
            List of chunk ids and segment ids
        counter: int:
            Counter for the next segment id

    """
    process_tracker_df = process_tracker_df[process_tracker_df['path'].isin(unprocessed_chunk_file_uri_li)]
    process_tracker_df = process_tracker_df.sort_values(by='timestamp')
    chunk_id_2_uri = dict(process_tracker_df[['chunk_id', 'path']].values)
    chunk_id_2_size = {chunk_id: _read_mp3_from_s3_and_get_wav_file_size(uri) for chunk_id, uri in chunk_id_2_uri.items()}
    chunk_id = list(chunk_id_2_size.keys())[0]
    chunk_id_2_segment = []
    segment_2_path = {}
    # One chunk to many segments
    if chunk_id_2_size[chunk_id] > max_size_mb:
        n_sub_chunks = int((chunk_id_2_size[chunk_id] // max_size_mb) + 1)
        audio_stream = get_stream_from_s3(chunk_id_2_uri[chunk_id])
        audio = AudioSegment.from_file(BytesIO(audio_stream.read()), format=format)
        chunk_length = len(audio) // n_sub_chunks
        for i in range(n_sub_chunks):
            segment_id = create_directus_segment(configid, counter)
            chunk_id_2_segment.append((chunk_id, segment_id))
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
    #Many chunks to one segment
    else:
        processed_chunk_li = []
        combined_size = 0
        combined_audio = AudioSegment.empty()
        segment_id = create_directus_segment(configid, counter)
        for chunk_id,size in chunk_id_2_size.items():
            combined_size = combined_size + size # type: ignore
            if combined_size<= max_size_mb:
                chunk_id_2_segment.append((chunk_id, segment_id))
                audio_stream = get_stream_from_s3(chunk_id_2_uri[chunk_id])
                audio = AudioSegment.from_file(BytesIO(audio_stream.read()), format=format)
                processed_chunk_li.append(chunk_id)
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
    

def create_directus_segment(configid: str, counter: float) -> str:
    response = directus.create_item(
            "conversation_segment",
            item_data={
                "config_id": configid,
                "counter": counter,
            },
        )
    directus_id = response['data']['id']
    return directus_id

def delete_directus_segment(segment_id: str) -> None:
    directus.delete_item("conversation_segment", segment_id)

def get_conversation_by_segment(conversation_id: str, segment_id: str) -> dict:
    response = directus.read_item("conversation", conversation_id, fields=["*"], filter={"segment": segment_id})
    return response['data']
