import pandas as pd


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
    
    def update_status(self, conversation_id: int, chunk_id: int, 
                      column_name: str, status: str) -> None:
        self.df.loc[(self.df.conversation_id == conversation_id) 
                    & (self.df.chunk_id == chunk_id), column_name] = status
    
    def update_value_for_chunk_id(self, chunk_id: str, column_name: str, value: str) -> None:
        self.df.loc[(self.df.chunk_id == chunk_id), column_name] = value

