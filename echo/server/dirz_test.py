import torch
from pyannote.audio import Pipeline

from dembrane.audio_lightrag.validation.validation_config import HF_TOKEN

pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1",
    use_auth_token=HF_TOKEN)

# # send pipeline to GPU (when available)
# pipeline.to(torch.device("cuda"))

# apply pretrained pipeline
diarization, embeddings = pipeline("/workspaces/echo/8B4BDO7exAw.wav", return_embeddings=True)

# print the result
for turn, _, speaker in diarization.itertracks(yield_label=True):
    print(f"start={turn.start:.1f}s stop={turn.end:.1f}s speaker_{speaker}")
