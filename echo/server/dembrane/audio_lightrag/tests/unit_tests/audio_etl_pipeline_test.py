# write unit tests for audio etl pipeline
import os
import sys

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../..")))


import pytest

from dembrane.audio_lightrag.pipelines.audio_etl_pipeline import AudioETLPipeline
from dembrane.audio_lightrag.pipelines.directus_etl_pipeline import DirectusETLPipeline

# @pytest.mark.usefixtures("conversation_df", "project_df")
# def test_tracker(conversation_df: pd.DataFrame, project_df: pd.DataFrame) -> None:
#     # Use conftest data to create a mock ProcessTracker object
#     mock_process_tracker = ProcessTracker(conversation_df=conversation_df,
#                                           project_df=project_df)   
#     mock_process_tracker.delete_temps()
#     assert set(mock_process_tracker().columns) == set(['conversation_id', 'project_id', 'chunk_id', 
#                                                    'path', 'timestamp', 'format', 
#                                                    'download_status', 'segment', 
#                                                    'log', 'json_status','ligtrag_status'])
#     assert mock_process_tracker().shape[0]*mock_process_tracker().shape[1] != 0

# @pytest.mark.usefixtures("conversation_df", "project_df")
# def test_partial_process_tracker(conversation_df: pd.DataFrame, project_df: pd.DataFrame) -> None:
#     conversation_df = pd.read_csv('server/dembrane/audio_lightrag/tests/data/partial_progress_tracker.csv')
#     process_tracker = ProcessTracker(conversation_df = conversation_df,
#                                      project_df=project_df)   
#     audio_etl_pipeline = AudioETLPipeline(process_tracker)
#     audio_etl_pipeline.run()
#     process_tracker.delete_temps()
#     assert (process_tracker()[process_tracker().segment==1].shape[0] == 5)
#     assert (process_tracker()[process_tracker().segment==2].shape[0] == 4)
 

# @pytest.mark.usefixtures("conversation_df", "project_df")
# def test_audio_etl_pipeline_m4a(conversation_df: pd.DataFrame, project_df: pd.DataFrame) -> None:
#     process_tracker = ProcessTracker(conversation_df=conversation_df[conversation_df.format=='m4a'],
#                                             project_df=project_df)   
#     audio_etl_pipeline = AudioETLPipeline(process_tracker)
#     audio_etl_pipeline.run()
#     process_tracker.delete_temps()
#     assert (process_tracker().shape[0] != 0)
#     assert (process_tracker()[process_tracker().segment==-1].shape[0] == 0)
#     assert (process_tracker()[process_tracker().segment.isna()].shape[0] == 0)

# @pytest.mark.usefixtures("conversation_df", "project_df")
# def test_audio_etl_pipeline_mp3(conversation_df: pd.DataFrame, 
#                                 project_df: pd.DataFrame) -> None:
#     process_tracker = ProcessTracker(conversation_df=
#                                      conversation_df[conversation_df.format=='mp3'],
#                                             project_df=project_df)   
#     audio_etl_pipeline = AudioETLPipeline(process_tracker)
#     audio_etl_pipeline.run()
#     # process_tracker.delete_temps()
#     assert (process_tracker().shape[0] != 0)
#     assert (process_tracker()[process_tracker().segment==-1].shape[0] == 0)
#     assert (process_tracker()[process_tracker().segment.isna()].shape[0] == 0)

@pytest.mark.usefixtures("test_audio_uuid")
def test_audio_etl_pipeline_ogg(test_audio_uuid: str) -> None:
    directus_etl_pipeline = DirectusETLPipeline()
    process_tracker = directus_etl_pipeline.run([test_audio_uuid])
    audio_etl_pipeline = AudioETLPipeline(process_tracker)
    audio_etl_pipeline.run()
    assert (process_tracker().shape[0] != 0)
    assert (process_tracker()[process_tracker().segment==-1].shape[0] == 0)
    assert (process_tracker()[process_tracker().segment.isna()].shape[0] == 0)

# @pytest.mark.usefixtures("conversation_df", "project_df")
# def test_audio_etl_pipeline_wav(conversation_df: pd.DataFrame, project_df: pd.DataFrame):
#     process_tracker = ProcessTracker(conversation_df=
#                                      conversation_df[conversation_df.format=='wav'],
#                                             project_df=project_df)   
#     audio_etl_pipeline = AudioETLPipeline(process_tracker)
#     audio_etl_pipeline.run()
#     process_tracker.delete_temps()
#     assert (process_tracker().shape[0] != 0)
#     assert (process_tracker()[process_tracker().segment==-1].shape[0] == 0)
#     assert (process_tracker()[process_tracker().segment.isna()].shape[0] == 0)

# @pytest.mark.usefixtures("conversation_df", "project_df")
# def test_audio_etl_pipeline_big_file(conversation_df: pd.DataFrame, project_df: pd.DataFrame):
#     process_tracker = ProcessTracker(conversation_df=
#                                      conversation_df[conversation_df.conversation_id=='55b93782-cf12-4cc3-b6e8-2815997f7bde'],
#                                             project_df=project_df)   
#     audio_etl_pipeline = AudioETLPipeline(process_tracker)
#     audio_etl_pipeline.run()
#     process_tracker.delete_temps()
#     assert (process_tracker().shape[0] == 1)
