import sys
from pathlib import Path

READINESS_FILE = Path("/tmp/celery_ready")
if not READINESS_FILE.is_file():
    print("Celery readiness file NOT found.")
    sys.exit(1)
print("Celery readiness file found.")
sys.exit(0)
