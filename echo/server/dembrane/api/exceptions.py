from fastapi import HTTPException

InternalServerException = HTTPException(status_code=500, detail="Something went wrong")

SessionInvalidException = HTTPException(status_code=401, detail="Invalid session")
SessionNotFoundException = HTTPException(status_code=404, detail="Session not found")

ProjectNotFoundException = HTTPException(status_code=404, detail="Project not found")
ProjectLanguageNotSupportedException = HTTPException(
    status_code=400, detail="Language not supported"
)
ProjectTagNotFoundException = HTTPException(status_code=404, detail="Tag not found")

ResourceInvalidFileFormatException = HTTPException(
    status_code=400, detail="Invalid file format. Only .pdf files are supported."
)
ResourceFailedToSaveFileException = HTTPException(status_code=500, detail="Failed to save the file")
ResourceNotFoundException = HTTPException(status_code=404, detail="Resource not found")
ResourceContentNotFoundException = HTTPException(
    status_code=500, detail="Resource content not found (Server Error)"
)

ConversationNotFoundException = HTTPException(status_code=404, detail="Conversation not found")
ConversationInvalidPinException = HTTPException(status_code=400, detail="Invalid pin")
ConversationNotOpenForParticipationException = HTTPException(
    status_code=400,
    detail="This conversation is not open for participation at this time",
)

class NoContentFoundException(HTTPException):
    def __init__(self) -> None:
        super().__init__(status_code=404, detail="No content found")
