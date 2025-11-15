"""Unit tests for utility functions that don't require external services"""
import re
from datetime import datetime, timezone

from dembrane.utils import (
    generate_uuid,
    get_safe_filename,
    get_utc_timestamp,
    generate_4_digit_pin,
    generate_6_digit_pin,
)


def test_generate_uuid():
    """Test that generate_uuid returns a valid UUID string"""
    uuid_str = generate_uuid()
    
    # Check it's a string
    assert isinstance(uuid_str, str)
    
    # Check it matches UUID format (8-4-4-4-12 hexadecimal digits)
    uuid_pattern = re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    )
    assert uuid_pattern.match(uuid_str), f"Invalid UUID format: {uuid_str}"
    
    # Check that calling it twice returns different UUIDs
    uuid_str2 = generate_uuid()
    assert uuid_str != uuid_str2, "UUIDs should be unique"


def test_generate_4_digit_pin():
    """Test that generate_4_digit_pin returns a 4-digit string"""
    pin = generate_4_digit_pin()
    
    # Check it's a string
    assert isinstance(pin, str)
    
    # Check it's exactly 4 characters
    assert len(pin) == 4, f"PIN should be 4 digits, got {len(pin)}"
    
    # Check it's all digits
    assert pin.isdigit(), f"PIN should only contain digits, got {pin}"
    
    # Check it's in valid range (1000-9999)
    pin_int = int(pin)
    assert 1000 <= pin_int <= 9999, f"PIN should be between 1000 and 9999, got {pin_int}"


def test_generate_6_digit_pin():
    """Test that generate_6_digit_pin returns a 6-digit string"""
    pin = generate_6_digit_pin()
    
    # Check it's a string
    assert isinstance(pin, str)
    
    # Check it's exactly 6 characters
    assert len(pin) == 6, f"PIN should be 6 digits, got {len(pin)}"
    
    # Check it's all digits
    assert pin.isdigit(), f"PIN should only contain digits, got {pin}"
    
    # Check it's in valid range (100000-999999)
    pin_int = int(pin)
    assert 100000 <= pin_int <= 999999, f"PIN should be between 100000 and 999999, got {pin_int}"


def test_get_utc_timestamp():
    """Test that get_utc_timestamp returns a UTC datetime"""
    timestamp = get_utc_timestamp()
    
    # Check it's a datetime
    assert isinstance(timestamp, datetime)
    
    # Check it has UTC timezone
    assert timestamp.tzinfo == timezone.utc, "Timestamp should have UTC timezone"
    
    # Check it's close to current time (within 1 second)
    now = datetime.now(tz=timezone.utc)
    time_diff = abs((now - timestamp).total_seconds())
    assert time_diff < 1, f"Timestamp should be current time, got difference of {time_diff}s"


def test_get_safe_filename():
    """Test that get_safe_filename sanitizes filenames correctly"""
    # Test replacing forward slashes
    assert get_safe_filename("path/to/file.txt") == "path_to_file.txt"
    
    # Test replacing backslashes
    assert get_safe_filename("path\\to\\file.txt") == "path_to_file.txt"
    
    # Test replacing spaces
    assert get_safe_filename("my file name.txt") == "my_file_name.txt"
    
    # Test combining multiple replacements
    assert get_safe_filename("path/to\\my file.txt") == "path_to_my_file.txt"
    
    # Test already safe filename
    assert get_safe_filename("safe_filename.txt") == "safe_filename.txt"
    
    # Test empty string
    assert get_safe_filename("") == ""
    
    # Test filename with only special characters
    assert get_safe_filename("/ \\ ") == "____"

