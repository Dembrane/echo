from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Union, Optional, Protocol, Generator
from contextlib import contextmanager
from dataclasses import dataclass
from urllib.parse import urljoin

import urllib3
import requests
from urllib3.exceptions import InsecureRequestWarning

from dembrane.settings import get_settings

# HTTP status codes that are typically recoverable
RECOVERABLE_STATUS_CODES = {
    401,  # Unauthorized (token expired)
    403,  # Forbidden (token invalid)
    408,  # Request Timeout
    429,  # Too Many Requests
    500,  # Internal Server Error
    502,  # Bad Gateway
    503,  # Service Unavailable
    504,  # Gateway Timeout
}


class DirectusGenericException(Exception):
    """Base Directus exception."""


class DirectusAuthError(DirectusGenericException):
    """Exception raised for authentication errors from Directus API."""

    def __init__(
        self,
        message: str,
        code: Optional[str] = None,
        extensions: Optional[Dict[str, Any]] = None,
    ):
        self.message = message
        self.code = code
        self.extensions = extensions or {}
        super().__init__(self.message)


class DirectusServerError(DirectusGenericException):
    """Exception raised for server connection errors to Directus API."""


class DirectusBadRequest(DirectusGenericException):
    """Exception raised for bad requests to Directus API (e.g., assertion errors)."""


def is_recoverable_error(response: requests.Response) -> bool:
    """
    Check if the response status code indicates a recoverable error.

    Args:
        response: The response object from the request

    Returns:
        bool: True if the error is recoverable, False otherwise
    """
    return response.status_code in RECOVERABLE_STATUS_CODES


def make_request_with_retry(
    client: DirectusClientProtocol,
    method: str,
    url: str,
    *,
    max_retries: int = 3,
    retry_delay: float = 1.0,
    **kwargs: Any,
) -> requests.Response:
    """
    Make an HTTP request with retry logic for recoverable errors.

    Args:
        client: The DirectusClient instance
        method: HTTP method to use
        url: URL to make the request to
        max_retries: Maximum number of retry attempts
        retry_delay: Initial delay between retries in seconds
        **kwargs: Additional arguments to pass to requests

    Returns:
        requests.Response: The response from the server

    Raises:
        requests.exceptions.RequestException: If the request fails after all retries
    """
    retries = 0
    while retries < max_retries:
        try:
            if client.temporary_token is not None and client.refresh_token is not None:
                try:
                    client.refresh()
                except Exception:
                    if client.email and client.password:
                        client.login(client.email, client.password)

            response = requests.request(method, url, **kwargs)

            if is_recoverable_error(response):
                retries += 1
                if retries == max_retries:
                    response.raise_for_status()

                wait_time = retry_delay * (2 ** (retries - 1))
                time.sleep(wait_time)

                if response.status_code in (401, 403):
                    try:
                        if client.email and client.password:
                            client.login(client.email, client.password)
                            if "headers" in kwargs:
                                kwargs["headers"]["Authorization"] = f"Bearer {client.get_token()}"
                    except Exception:
                        continue
                continue

            return response

        except requests.exceptions.RequestException as exc:
            if getattr(exc, "response", None) is not None:
                if exc.response is not None and not is_recoverable_error(exc.response):
                    raise

            retries += 1
            if retries == max_retries:
                raise

            wait_time = retry_delay * (2 ** (retries - 1))
            time.sleep(wait_time)
            continue

    return requests.request(method, url, **kwargs)


class DirectusClientProtocol(Protocol):
    """Typed protocol shim to help with static analysis."""

    url: str
    email: Optional[str]
    password: Optional[str]
    verify: bool
    temporary_token: Optional[str]
    static_token: Optional[str]
    refresh_token: Optional[str]

    def get_token(self) -> str: ...

    def login(self, email: Optional[str] = None, password: Optional[str] = None) -> dict: ...

    def refresh(self, refresh_token: Optional[str] = None) -> dict: ...


class DirectusClient(DirectusClientProtocol):
    def __init__(
        self,
        url: str,
        token: Optional[str] = None,
        email: Optional[str] = None,
        password: Optional[str] = None,
        verify: bool = False,
    ):
        """
        Initialize the DirectusClient.

        Args:
            url (str): The URL of the Directus instance.
            token (str): The static token for authentication (optional).
            email (str): The email for authentication (optional).
            password (str): The password for authentication (optional).
            verify (bool): Whether to verify SSL certificates (default: False).
        """
        self.verify = verify
        if not self.verify:
            urllib3.disable_warnings(category=InsecureRequestWarning)

        self.url = url
        self.static_token: Optional[str] = None
        self.temporary_token: Optional[str] = None
        self.refresh_token: Optional[str] = None
        self.expires: Optional[int] = None
        self.email: Optional[str] = email
        self.password: Optional[str] = password

        if token is not None:
            self.static_token = token
        elif email is not None and password is not None:
            self.login(email, password)

    def login(self, email: Optional[str] = None, password: Optional[str] = None) -> dict:
        """
        Login with the /auth/login endpoint.

        Args:
            email (str): The email for authentication (optional).
            password (str): The password for authentication (optional).

        Returns:
            dict: The authentication data containing access_token, refresh_token and expires.

        Raises:
            DirectusAuthError: If authentication fails or the API returns an error.
            requests.RequestException: If there is a network or API error.
        """
        if email is None or password is None:
            email = self.email
            password = self.password
        else:
            self.email = email
            self.password = password

        response = requests.post(
            f"{self.url}/auth/login",
            json={"email": email, "password": password},
            verify=self.verify,
        )
        auth_data = self._get_validated_auth_data(response)
        self.static_token = None
        self.temporary_token = auth_data["access_token"]
        self.refresh_token = auth_data["refresh_token"]
        self.expires = auth_data["expires"]
        return auth_data

    def logout(self, refresh_token: Optional[str] = None) -> None:
        """
        Logout using the /auth/logout endpoint.

        Args:
            refresh_token (str): The refresh token (optional).
        """
        try:
            if refresh_token is None:
                refresh_token = self.refresh_token
            response = requests.post(
                f"{self.url}/auth/logout",
                headers={"Authorization": f"Bearer {self.get_token()}"},
                json={"refresh_token": refresh_token},
                verify=self.verify,
            )
            response.raise_for_status()
            self.temporary_token = None
            self.refresh_token = None
        except requests.exceptions.HTTPError as exc:
            raise DirectusAuthError(f"Failed to logout from Directus API: {exc}") from exc

    def refresh(self, refresh_token: Optional[str] = None) -> dict:
        """
        Retrieve new temporary access token and refresh token.

        Args:
            refresh_token (str): The refresh token (optional).
        """
        if refresh_token is None:
            refresh_token = self.refresh_token
        response = requests.post(
            f"{self.url}/auth/refresh",
            json={"refresh_token": refresh_token, "mode": "json"},
            verify=self.verify,
        )
        auth_data = self._get_validated_auth_data(response)
        self.temporary_token = auth_data["access_token"]
        self.refresh_token = auth_data["refresh_token"]
        self.expires = auth_data["expires"]

        return auth_data

    def get_token(self) -> str:
        """
        Get the authentication token.

        Returns:
            str: The authentication token.
        """
        if self.static_token is not None:
            token = self.static_token
        elif self.temporary_token is not None:
            token = self.temporary_token
        else:
            token = ""
        return token

    def clean_url(self, domain: str, path: str) -> str:
        """
        Clean the URL by removing any leading slash.
        """
        clean_path = urljoin(domain, path)
        clean_path = (
            clean_path.replace("//", "/")
            if not clean_path.startswith("http://")
            and not clean_path.startswith("https://")
            and not clean_path.startswith("//")
            else clean_path
        )
        return clean_path

    def get(self, path: str, output_type: str = "json", **kwargs: Any) -> Any:
        """
        Perform a GET request to the specified path.
        """
        try:
            headers = {"Authorization": f"Bearer {self.get_token()}"}
            request_kwargs = {"headers": headers, "verify": self.verify}
            request_kwargs.update(kwargs)
            data = make_request_with_retry(
                client=self,
                method="GET",
                url=self.clean_url(self.url, path),
                max_retries=3,
                retry_delay=1.0,
                **request_kwargs,
            )
            try:
                data_json = data.json()
            except json.JSONDecodeError:
                return data.text

            if "errors" in data_json:
                raise AssertionError(data_json["errors"])

            if output_type == "csv":
                return data.text
            return data_json["data"]
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def post(self, path: str, **kwargs: Any) -> Dict[str, Any]:
        """
        Perform a POST request to the specified path.
        """
        try:
            headers = {"Authorization": f"Bearer {self.get_token()}"}
            request_kwargs = {"headers": headers, "verify": self.verify}
            request_kwargs.update(kwargs)
            response = make_request_with_retry(
                client=self,
                method="POST",
                url=self.clean_url(self.url, path),
                max_retries=3,
                retry_delay=1.0,
                **request_kwargs,
            )
            if response.status_code != 200:
                raise AssertionError(response.text)

            return response.json()
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def search(self, path: str, query: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Any:
        """
        Perform a SEARCH request to the specified path.
        """
        headers = {"Authorization": f"Bearer {self.get_token()}"}
        request_kwargs = {"headers": headers, "verify": self.verify, "json": query}
        request_kwargs.update(kwargs)
        try:
            response = make_request_with_retry(
                client=self,
                method="SEARCH",
                url=self.clean_url(self.url, path),
                max_retries=3,
                retry_delay=1.0,
                **request_kwargs,
            )

            try:
                return response.json()["data"]
            except Exception as exc:  # noqa: BLE001 - want best-effort fallback
                return {"error": f"No data found for this request : {exc}"}
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def delete(self, path: str, **kwargs: Any) -> None:
        """
        Perform a DELETE request to the specified path.
        """
        try:
            headers = {"Authorization": f"Bearer {self.get_token()}"}
            request_kwargs = {"headers": headers, "verify": self.verify}
            request_kwargs.update(kwargs)
            response = make_request_with_retry(
                client=self,
                method="DELETE",
                url=self.clean_url(self.url, path),
                max_retries=3,
                retry_delay=1.0,
                **request_kwargs,
            )
            if response.status_code != 204:
                raise AssertionError(response.text)
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def patch(self, path: str, **kwargs: Any) -> Dict[str, Any]:
        """
        Perform a PATCH request to the specified path.
        """
        try:
            headers = {"Authorization": f"Bearer {self.get_token()}"}
            request_kwargs = {"headers": headers, "verify": self.verify}
            request_kwargs.update(kwargs)
            response = make_request_with_retry(
                client=self,
                method="PATCH",
                url=self.clean_url(self.url, path),
                max_retries=3,
                retry_delay=1.0,
                **request_kwargs,
            )

            if response.status_code not in [200, 204]:
                raise AssertionError(response.text)

            return response.json()
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def me(self) -> Dict[str, Any]:
        """
        Get the current user.
        """
        return self.get("/users/me")

    def get_users(self, query: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Any:
        """
        Get users based on the provided query.
        """
        return self.search("/users", query=query, **kwargs)

    def create_user(self, user_data: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
        """
        Create a new user.
        """
        return self.post("/users", json=user_data, **kwargs)

    def update_user(self, user_id: str, user_data: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
        """
        Update a user.
        """
        return self.patch(f"/users/{user_id}", json=user_data, **kwargs)

    def delete_user(self, user_id: str, **kwargs: Any) -> None:
        """
        Delete a user.
        """
        self.delete(f"/users/{user_id}", **kwargs)

    def get_files(self, query: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Any:
        """
        Get files based on the provided query.
        """
        return self.search("/files", query=query, **kwargs)

    def retrieve_file(self, file_id: str, **kwargs: Any) -> Union[str, bytes]:
        """
        Retrieve information about a file, not the way to download it.
        """
        url = f"{self.url}/files/{file_id}"
        headers = {"Authorization": f"Bearer {self.get_token()}"}
        request_kwargs = {"headers": headers, "verify": self.verify}
        request_kwargs.update(kwargs)
        try:
            response = make_request_with_retry(
                client=self,
                method="GET",
                url=url,
                max_retries=3,
                retry_delay=1.0,
                **request_kwargs,
            )
            if response.status_code != 200:
                raise AssertionError(response.text)
            return response.content
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def download_file(self, file_id: str, file_path: str) -> None:
        """
        Download a Directus asset to disk.
        """
        url = f"{self.url}/assets/{file_id}?download="
        headers = {"Authorization": f"Bearer {self.get_token()}"}
        request_kwargs = {"headers": headers, "verify": self.verify}
        try:
            response = make_request_with_retry(
                client=self,
                method="GET",
                url=url,
                max_retries=3,
                retry_delay=1.0,
                **request_kwargs,
            )
            if response.status_code != 200:
                raise AssertionError(response.text)
            with open(file_path, "wb") as file:
                file.write(response.content)
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def download_photo(
        self,
        file_id: str,
        file_path: str,
        display: Dict[str, Any] | None = None,
        transform: List[Any] | None = None,
    ) -> None:
        """
        Download a photo (with optional transforms) from Directus.
        """
        if display is None:
            display = {}
        if transform is None:
            transform = []
        if transform:
            display["transforms"] = json.dumps(transform)

        url = f"{self.url}/assets/{file_id}?download="
        headers = {"Authorization": f"Bearer {self.get_token()}"}
        request_kwargs = {"headers": headers, "verify": self.verify, "params": display}
        try:
            response = make_request_with_retry(
                client=self,
                method="GET",
                url=url,
                max_retries=3,
                retry_delay=1.0,
                **request_kwargs,
            )
            if response.status_code != 200:
                raise AssertionError(response.text)
            with open(file_path, "wb") as file:
                file.write(response.content)
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def get_url_file(
        self,
        file_id: str,
        display: Dict[str, Any] | None = None,
        transform: List[Any] | None = None,
    ) -> str:
        """
        Retrieve a public URL for a file.
        """
        if display is None:
            display = {}
        if transform:
            display["transforms"] = json.dumps(transform)

        url = f"{self.url}/assets/{file_id}"
        if display:
            params = "&".join([f"{key}={value}" for key, value in display.items()])
            url = f"{url}?{params}"
        return url

    def define_file_type(self, file_path: str) -> str:
        """
        Define the file type based on the file extension.
        """
        ext_file = file_path.split(".")[-1]
        if ext_file in ["jpg"]:
            return "image/jpeg"
        if ext_file in ["png", "webp", "gif"]:
            return f"image/{ext_file}"
        if ext_file == "pdf":
            return "application/pdf"
        if ext_file in ["doc", "docx"]:
            return "application/msword"
        if ext_file in ["xls", "xlsx"]:
            return "application/vnd.ms-excel"
        if ext_file == "odt":
            return "application/vnd.oasis.opendocument.text"
        if ext_file == "ods":
            return "application/vnd.oasis.opendocument.spreadsheet"
        return "text/plain"

    def upload_file(self, file_path: str, data: Dict[str, Any] | None = None) -> Dict[str, Any]:
        """
        Upload a file to Directus.
        """
        if data is None:
            data = {}
        url = f"{self.url}/files"
        headers = {"Authorization": f"Bearer {self.get_token()}"}
        try:
            with open(file_path, "rb") as file:
                files = {"file": file}
                request_kwargs = {"headers": headers, "files": files, "verify": self.verify}
                response = make_request_with_retry(
                    client=self,
                    method="POST",
                    url=url,
                    max_retries=3,
                    retry_delay=1.0,
                    **request_kwargs,
                )
            if response.status_code != 200:
                raise AssertionError(response.text)

            result = response.json()["data"]
            data["type"] = self.define_file_type(file_path)
            if data and result:
                file_id = result["id"]
                patched = self.patch(f"/files/{file_id}", json=data)
                result = patched["data"]

            return result
        except requests.exceptions.ConnectionError as exc:
            raise DirectusServerError(exc) from exc
        except AssertionError as exc:
            raise DirectusBadRequest(exc) from exc

    def delete_file(self, file_id: str, **kwargs: Any) -> None:
        """
        Delete a file.
        """
        self.delete(f"/files/{file_id}", **kwargs)

    def get_collection(self, collection_name: str, **kwargs: Any) -> Dict[str, Any]:
        """
        Get a collection.
        """
        return self.get(f"/collections/{collection_name}", **kwargs)

    def get_items(
        self, collection_name: str, query: Optional[Dict[str, Any]] = None, **kwargs: Any
    ) -> Any:
        """
        Get items from a collection based on the provided query.
        """
        return self.search(f"/items/{collection_name}", query=query, **kwargs)

    def get_item(
        self,
        collection_name: str,
        item_id: str,
        uery: Optional[Dict[str, Any]] = None,  # noqa: ARG002
        **kwargs: Any,
    ) -> Any:
        """
        Get a single item from a collection based on the provided query.
        """
        return self.get(f"/items/{collection_name}/{item_id}", **kwargs)

    def create_item(
        self, collection_name: str, item_data: Dict[str, Any] | List[Dict[str, Any]], **kwargs: Any
    ) -> Dict[str, Any]:
        """
        Create a new item in a collection.
        """
        return self.post(f"/items/{collection_name}", json=item_data, **kwargs)

    def update_item(
        self, collection_name: str, item_id: str, item_data: Dict[str, Any], **kwargs: Any
    ) -> Dict[str, Any]:
        """
        Update an item in a collection.
        """
        return self.patch(f"/items/{collection_name}/{item_id}", json=item_data, **kwargs)

    def update_file(self, item_id: str, item_data: Dict[str, Any], **kwargs: Any) -> Dict[str, Any]:
        """
        Update file metadata.
        """
        return self.patch(f"/files/{item_id}", json=item_data, **kwargs)

    def delete_item(self, collection_name: str, item_id: str, **kwargs: Any) -> None:
        """
        Delete an item from a collection.
        """
        self.delete(f"/items/{collection_name}/{item_id}", **kwargs)

    def bulk_insert(
        self,
        collection_name: str,
        items: List[Dict[str, Any]],
        interval: int = 100,
        verbose: bool = False,
    ) -> None:
        """
        Insert multiple items into a collection in bulk.
        """
        length = len(items)
        for i in range(0, length, interval):
            if verbose:
                print(f"Inserting {i}-{min(i + interval, length)} out of {length}")
            self.post(f"/items/{collection_name}", json=items[i : i + interval])

    def duplicate_collection(self, collection_name: str, duplicate_collection_name: str) -> None:
        """
        Duplicate a collection with its schema, fields, and data.
        """
        duplicate_collection = self.get(f"/collections/{collection_name}")
        duplicate_collection["collection"] = duplicate_collection_name
        duplicate_collection["meta"]["collection"] = duplicate_collection_name
        duplicate_collection["schema"]["name"] = duplicate_collection_name
        self.post("/collections", json=duplicate_collection)

        fields = [
            field
            for field in self.get_all_fields(collection_name)
            if not field["schema"]["is_primary_key"]
        ]
        for field in fields:
            self.post(f"/fields/{duplicate_collection_name}", json=field)

        items = self.get(f"/items/{collection_name}", params={"limit": -1})
        self.bulk_insert(duplicate_collection_name, items)

    def collection_exists(self, collection_name: str) -> bool:
        """
        Check if a collection exists in Directus.
        """
        collection_schema = [col["collection"] for col in self.get("/collections")]
        return collection_name in collection_schema

    def delete_all_items(self, collection_name: str) -> None:
        """
        Delete all items from a collection.
        """
        pk_name = self.get_pk_field(collection_name)["field"]
        item_ids = [
            data["id"]
            for data in self.get(f"/items/{collection_name}?fields={pk_name}", params={"limit": -1})
        ]
        if not item_ids:
            raise AssertionError("No items to delete!")

        for i in range(0, len(item_ids), 100):
            self.delete(f"/items/{collection_name}", json=item_ids[i : i + 100])

    def get_all_fields(
        self, collection_name: str, query: Optional[Dict[str, Any]] = None, **kwargs: Any
    ) -> List[Dict[str, Any]]:
        """
        Get all fields of a collection based on the provided query.
        """
        fields = self.search(f"/fields/{collection_name}", query=query, **kwargs)
        for field in fields:
            if field.get("meta") and field["meta"].get("id"):
                field["meta"].pop("id")

        return fields

    def get_pk_field(self, collection_name: str) -> Dict[str, Any]:
        """
        Get the primary key field of a collection.
        """
        return next(
            field
            for field in self.get(f"/fields/{collection_name}")
            if field["schema"]["is_primary_key"]
        )

    def get_all_user_created_collection_names(
        self, query: Optional[Dict[str, Any]] = None, **kwargs: Any
    ) -> List[str]:
        """
        Get all user-created collection names based on the provided query.
        """
        collections = self.search("/collections", query=query, **kwargs)
        return [
            col["collection"] for col in collections if not col["collection"].startswith("directus")
        ]

    def get_all_fk_fields(
        self, collection_name: str, query: Optional[Dict[str, Any]] = None, **kwargs: Any
    ) -> List[Dict[str, Any]]:
        """
        Get all foreign key fields of a collection.
        """
        fields = self.search(f"/fields/{collection_name}", query=query, **kwargs)
        return [field for field in fields if field["schema"].get("foreign_key_table")]

    def get_relations(
        self, collection_name: str, query: Optional[Dict[str, Any]] = None, **kwargs: Any
    ) -> List[Dict[str, Any]]:
        """
        Get all relations of a collection based on the provided query.
        """
        relations = self.search(f"/relations/{collection_name}", query=query, **kwargs)
        return [
            {
                "collection": relation["collection"],
                "field": relation["field"],
                "related_collection": relation["related_collection"],
            }
            for relation in relations
        ]

    def post_relation(self, relation: Dict[str, Any]) -> None:
        """
        Create a new relation.
        """
        assert set(relation.keys()) == {"collection", "field", "related_collection"}
        try:
            self.post("/relations", json=relation)
        except AssertionError as exc:
            if '"id" has to be unique' in str(exc):
                self.post_relation(relation)
            else:
                raise

    def search_query(
        self,
        query: str,
        exclude_worlds_len: int = 2,
        cut_words: bool = True,
        **kwargs: Any,  # noqa: ARG002
    ) -> Dict[str, Any]:
        words: List[str]
        if cut_words:
            words = [word for word in query.split() if len(word) > exclude_worlds_len]
        else:
            words = [query]
        return {"query": {"search": words}}

    def _validate_auth_response(self, response: requests.Response) -> requests.Response:
        """
        Validate the authentication response from the Directus API.
        """
        required_fields = ["access_token", "refresh_token", "expires"]
        try:
            response.raise_for_status()
            auth_data = response.json()
            if "errors" in auth_data:
                error = auth_data["errors"][0]
                raise DirectusAuthError(
                    message=error.get("message", "Unknown authentication error"),
                    code=error.get("code"),
                    extensions=error.get("extensions"),
                )
            if "data" not in auth_data:
                raise DirectusAuthError(
                    "Invalid response format received during login: missing 'data' field"
                )
            auth = auth_data["data"]
            missing_fields = [field for field in required_fields if field not in auth]
            if missing_fields:
                raise DirectusAuthError(
                    f"Missing required fields in response: {', '.join(missing_fields)}"
                )
            return response
        except (
            KeyError,
            ValueError,
            json.JSONDecodeError,
            requests.exceptions.HTTPError,
        ) as exc:
            raise DirectusAuthError(f"Invalid response format from API: {exc}") from exc

    def _get_validated_auth_data(self, response: requests.Response) -> dict:
        """
        Get the validated authentication data from the Directus API.
        """
        auth_data = self._validate_auth_response(response)
        return auth_data.json()["data"]


def _format_sql(sql: str) -> str:
    """Format SQL query before parsing."""
    sql = sql.replace("(", " ( ")
    sql = sql.replace(")", " ) ")
    sql = " ".join(sql.split())
    return sql


@dataclass
class DOp:
    EQUALS = "_eq"
    NOT_EQUALS = "_neq"
    LESS_THAN = "_lt"
    LESS_THAN_EQUAL = "_lte"
    GREATER_THAN = "_gt"
    GREATER_THAN_EQUAL = "_gte"
    IN = "_in"
    NOT_IN = "_nin"
    NULL = "_null"
    NOT_NULL = "_nnull"
    CONTAINS = "_contains"
    NOT_CONTAINS = "_ncontains"
    STARTS_WITH = "_starts_with"
    ENDS_WITH = "_ends_with"
    BETWEEN = "_between"
    NOT_BETWEEN = "_nbetween"
    EMPTY = "_empty"
    NOT_EMPTY = "_nempty"


settings = get_settings()
_DEFAULT_VERIFY = bool(getattr(settings.directus, "verify_ssl", False))


def create_directus_client(
    *,
    token: Optional[str] = None,
    email: Optional[str] = None,
    password: Optional[str] = None,
    verify: Optional[bool] = None,
) -> DirectusClient:
    """
    Factory for DirectusClient instances scoped to specific credentials.
    """
    resolved_verify = _DEFAULT_VERIFY if verify is None else verify
    return DirectusClient(
        url=settings.directus.base_url,
        token=token,
        email=email,
        password=password,
        verify=resolved_verify,
    )


directus = create_directus_client(token=settings.directus.token)


@contextmanager
def directus_client_context(
    client: Optional[DirectusClient] = None,
) -> Generator[DirectusClient, None, None]:
    """
    Provide a DirectusClient within a context manager, normalizing exceptions.
    """
    active_client = client or directus
    try:
        yield active_client
    except DirectusGenericException:
        raise
    except requests.exceptions.ConnectionError as exc:
        raise DirectusServerError(exc) from exc
    except AssertionError as exc:
        raise DirectusBadRequest(exc) from exc
    except Exception as exc:  # noqa: BLE001
        raise DirectusGenericException(exc) from exc


__all__ = [
    "DirectusClient",
    "DirectusGenericException",
    "DirectusAuthError",
    "DirectusServerError",
    "DirectusBadRequest",
    "DOp",
    "directus",
    "directus_client_context",
    "create_directus_client",
]
