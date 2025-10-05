"""
Caching layer for S3 audio streams to avoid redundant downloads.

Problem: Current code downloads the same S3 file multiple times:
- Once to check metadata
- Once to decode audio
- Once to process segments

Solution: Cache the bytes in memory (audio files are typically < 5MB each).
"""
import logging
from io import BytesIO
from typing import Dict, Optional

from dembrane.s3 import get_stream_from_s3

logger = logging.getLogger(__name__)


class S3StreamCache:
    """
    Simple in-memory cache for S3 audio streams.
    
    Caches file bytes to avoid redundant S3 downloads within the same ETL run.
    Cache is cleared after each conversation to prevent memory bloat.
    """
    
    def __init__(self, max_cache_mb: int = 500):
        """
        Initialize S3 cache.
        
        Args:
            max_cache_mb: Maximum cache size in MB (default 500MB)
        """
        self.cache: Dict[str, bytes] = {}
        self.cache_hits = 0
        self.cache_misses = 0
        self.max_cache_bytes = max_cache_mb * 1024 * 1024
        self.current_cache_bytes = 0
    
    def get(self, s3_uri: str) -> Optional[BytesIO]:
        """
        Get cached stream or download and cache it.
        
        Args:
            s3_uri: S3 URI of the file
            
        Returns:
            BytesIO stream with file contents, or None if error
        """
        # Check cache first
        if s3_uri in self.cache:
            self.cache_hits += 1
            logger.debug(f"Cache HIT for {s3_uri} (hits={self.cache_hits}, misses={self.cache_misses})")
            return BytesIO(self.cache[s3_uri])
        
        # Cache miss - download from S3
        self.cache_misses += 1
        logger.debug(f"Cache MISS for {s3_uri} (hits={self.cache_hits}, misses={self.cache_misses})")
        
        stream = None
        try:
            stream = get_stream_from_s3(s3_uri)
            data = stream.read()
            
            # Check if adding this would exceed cache size
            data_size = len(data)
            if self.current_cache_bytes + data_size > self.max_cache_bytes:
                logger.warning(
                    f"Cache full ({self.current_cache_bytes / 1024 / 1024:.1f}MB), "
                    f"cannot cache {s3_uri} ({data_size / 1024 / 1024:.1f}MB)"
                )
                # Return stream without caching
                return BytesIO(data)
            
            # Add to cache
            self.cache[s3_uri] = data
            self.current_cache_bytes += data_size
            
            logger.debug(
                f"Cached {s3_uri} ({data_size / 1024:.1f}KB), "
                f"total cache: {self.current_cache_bytes / 1024 / 1024:.1f}MB"
            )
            
            return BytesIO(data)
            
        except Exception as e:
            logger.error(f"Failed to download/cache {s3_uri}: {e}")
            return None
        finally:
            if stream is not None:
                try:
                    stream.close()
                except Exception as close_error:
                    logger.warning(f"Failed to close S3 stream for {s3_uri}: {close_error}")
    
    def clear(self) -> None:
        """Clear the cache to free memory."""
        num_items = len(self.cache)
        cache_mb = self.current_cache_bytes / 1024 / 1024
        
        logger.info(
            f"Clearing S3 cache: {num_items} files, {cache_mb:.1f}MB, "
            f"hit rate: {self.get_hit_rate():.1%}"
        )
        
        self.cache.clear()
        self.current_cache_bytes = 0
        self.cache_hits = 0
        self.cache_misses = 0
    
    def get_hit_rate(self) -> float:
        """Get cache hit rate."""
        total = self.cache_hits + self.cache_misses
        if total == 0:
            return 0.0
        return self.cache_hits / total
    
    def get_stats(self) -> Dict[str, any]:
        """Get cache statistics."""
        return {
            "size_mb": self.current_cache_bytes / 1024 / 1024,
            "num_items": len(self.cache),
            "hits": self.cache_hits,
            "misses": self.cache_misses,
            "hit_rate": self.get_hit_rate(),
        }
    
    def __enter__(self):
        """Context manager support."""
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Clear cache on context exit."""
        self.clear()


# Global cache instance (per worker process)
_global_cache = S3StreamCache()


def get_cached_s3_stream(s3_uri: str) -> Optional[BytesIO]:
    """
    Get S3 stream with caching.
    
    This is a drop-in replacement for get_stream_from_s3() that adds caching.
    
    Args:
        s3_uri: S3 URI of the file
        
    Returns:
        BytesIO stream or None if error
    """
    return _global_cache.get(s3_uri)


def clear_s3_cache() -> None:
    """Clear the global S3 cache."""
    _global_cache.clear()


def get_s3_cache_stats() -> Dict[str, any]:
    """Get global S3 cache statistics."""
    return _global_cache.get_stats()
