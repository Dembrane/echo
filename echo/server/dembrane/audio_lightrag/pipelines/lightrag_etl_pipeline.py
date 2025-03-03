import os
import json

# import nest_asyncio
# nest_asyncio.apply()
import logging

import yaml
import requests

from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker

# from lightrag import LightRAG
# from lightrag.llm.azure_openai import azure_openai_complete

# from dembrane.audio_lightrag.utils.lightrag_utils import embedding_func, initialize_postgres_db

# Configure logging
logging.basicConfig(level=logging.ERROR, format="%(asctime)s - %(levelname)s - %(message)s")

class LightragETLPipeline:
    def __init__(self, 
                 process_tracker: ProcessTracker, 
                 config_path: str = "server/dembrane/audio_lightrag/configs/lightrag_etl_pipeline_config.yaml",
                 api_base_url: str = "http://localhost:8000/api/stateless/rag" ) -> None:
        print('********** Running ETL pipeline **********')
        self.config = self.load_config(config_path)
        self.process_tracker = process_tracker
        self.api_base_url = api_base_url

    def load_config(self, config_path: str) -> dict:
        with open(config_path, "r") as file:
            return yaml.safe_load(file)

    def extract(self) -> None:
        """Data extraction step."""
        pass

    def transform(self) -> None:
        """Data transformation step."""
        pass

    def load(self) -> None:
        """Data loading step using FastAPI endpoints."""
        directory_path = self.config['directory_path']
        for conv_id in set(self.process_tracker()[self.process_tracker().ligtrag_status.isna()].conversation_id.to_list()):
            filename = f"{conv_id}.json"
            file_path = os.path.join(directory_path, filename)
            try:
                with open(file_path, "r", encoding="utf-8") as file:
                    data = json.load(file)
                    transcripts = [dict['CONTEXTUAL_TRANSCRIPT'] 
                                 for _, dict in data.items()]
                    
                    # Insert each transcript using the API
                    for transcript in transcripts:
                        response = requests.post(
                            f"{self.api_base_url}/insert",
                            json={"content": transcript}
                        )
                        response.raise_for_status()  # Raises an exception for 4XX/5XX status codes
                    
                    status = 'pass'
            except requests.exceptions.RequestException as e:
                logging.error(f"API request failed for {filename}: {e}")
                status = 'fail'
                continue
            except Exception as e:
                logging.error(f"Failed to process {filename}: {e}")
                status = 'fail'
                continue

            self.process_tracker.update_ligtrag_status(conv_id, status)                    


    def run(self) -> None:
        """Run the ETL pipeline."""
        self.extract()
        self.transform()
        self.load()


# if __name__ == "__main__":
#     import pandas as pd
#     from dotenv import load_dotenv

#     from dembrane.audio_lightrag.utils.process_tracker import ProcessTracker
#     load_dotenv()

#     process_tracker = ProcessTracker(pd.read_csv('server/dembrane/audio_lightrag/tests/data/test_conversation_df.csv').sample(5, random_state=42), 
#                                      project_df = pd.read_csv('server/dembrane/audio_lightrag/tests/data/test_project_df.csv').set_index('id'))
    
#     pipeline = LightragETLPipeline(process_tracker, 
#                                    api_base_url = "http://localhost:8010")
#     pipeline.run()

    