"""Basic health check smoke tests"""
import pytest
import requests


@pytest.mark.smoke
def test_api_health_endpoint(api_url):
    """Test that API health endpoint is accessible and healthy"""
    response = requests.get(f"{api_url}/api/health", timeout=10)
    assert response.status_code == 200
    data = response.json()
    assert data.get("status") in ["ok", "healthy"]


@pytest.mark.smoke
def test_api_docs_accessible(api_url):
    """Test that API documentation is accessible"""
    response = requests.get(f"{api_url}/docs", timeout=10)
    assert response.status_code == 200
    assert len(response.content) > 0


@pytest.mark.smoke
def test_directus_ping(directus_url):
    """Test that Directus server is responding"""
    response = requests.get(f"{directus_url}/server/ping", timeout=10)
    assert response.status_code == 200
    assert response.text == "pong"

