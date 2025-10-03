import json
import base64
import pandas as pd
from typing import Dict, Any
from io import StringIO


class ProcessTracker:
    def __init__(self, 
                 conversation_df: pd.DataFrame, 
                 project_df: pd.DataFrame,
                 ) -> None:
        """
        Initialize the ProcessTracker.

        Args:
        - df (pd.DataFrame): DataFrame containing the information to be tracked.
        - df_path (str): Path to save the DataFrame.
        """
        self.df = conversation_df
        self.project_df = project_df
        # Ensure the columns are present
        if 'segment' not in conversation_df.columns:
            self.df['segment'] = None
        self.project_df = project_df


    def __call__(self) -> pd.DataFrame:
        return self.df


    def get_project_df(self) -> pd.DataFrame: 
        return self.project_df
    
    def get_unprocesssed_process_tracker_df(self, column_name: str) -> pd.DataFrame:
        return self.df[self.df[column_name].isna()]
    
    def update_value_for_chunk_id(self, chunk_id: str, column_name: str, value: str) -> None:
        self.df.loc[(self.df.chunk_id == chunk_id), column_name] = value
    
    def to_dict(self) -> Dict[str, Any]:
        """
        Serialize ProcessTracker to a dictionary for passing between tasks.
        
        Returns:
            Dict with base64-encoded dataframes
        """
        return {
            "conversation_df": self.df.to_json(orient="split", date_format="iso"),
            "project_df": self.project_df.to_json(orient="split", date_format="iso"),
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ProcessTracker":
        """
        Deserialize ProcessTracker from a dictionary.
        
        Args:
            data: Dict with serialized dataframes
            
        Returns:
            ProcessTracker instance
        """
        conversation_df = pd.read_json(StringIO(data["conversation_df"]), orient="split")
        project_df = pd.read_json(StringIO(data["project_df"]), orient="split")
        return cls(conversation_df, project_df)

