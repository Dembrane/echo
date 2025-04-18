# import pytest
# from neo4j import GraphDatabase
# import os
# from unittest.mock import patch

# class TestNeo4jConnection:
#     @pytest.fixture
#     def neo4j_uri(self) -> str:
#         # Using environment variable or default test URI
#         return os.getenv("NEO4J_URI", "bolt://localhost:7687")

#     @pytest.fixture
#     def neo4j_user(self) -> str:
#         return os.getenv("NEO4J_USER", "neo4j")

#     @pytest.fixture
#     def neo4j_password(self) -> str:
#         return os.getenv("NEO4J_PASSWORD", "password")

#     @pytest.fixture
#     def driver(self, neo4j_uri: str, neo4j_user: str, neo4j_password: str) -> GraphDatabase.driver:
#         driver = GraphDatabase.driver(
#             neo4j_uri,
#             auth=(neo4j_user, neo4j_password)
#         )
#         yield driver
#         driver.close()

#     # def test_neo4j_connection_and_query(self, driver: GraphDatabase.driver) -> None:
#     #     # Test connection
#     #     try:
#     #         # Verify connection is alive
#     #         assert driver.verify_connectivity()

#     #         # Test simple query
#     #         with driver.session() as session:
#     #             # Simple query to return 1
#     #             result = session.run("RETURN 1 AS num")
#     #             record = result.single()
#     #             assert record is not None
#     #             assert record["num"] == 1

#     #     except Exception as e:
#     #         pytest.fail(f"Failed to connect to or query Neo4j: {str(e)}")

#     def test_neo4j_failed_connection(self) -> None:
#         # Test with invalid credentials
#         with pytest.raises(Exception):
#             driver = GraphDatabase.driver(
#                 "bolt://localhost:7687",
#                 auth=("invalid_user", "invalid_password")
#             )
#             driver.verify_connectivity()
