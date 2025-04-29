module.exports = {
  // this is assuming we are in the dev container. which means that
  // this NEEDS to be done after the build is complete
  // OR needs to be run in the same container as the directus server
  dumpPath: './sync',
  preserveIds: ['roles', 'policies', 'dashboards', 'panels'],
  exclude: {
    collections: [
      "lightrag_chunk_graph_map","lightrag_doc_chunks","lightrag_doc_full","lightrag_doc_status",
      "lightrag_llm_cache","lightrag_vdb_entity","lightrag_vdb_relation","lightrag_vdb_transcript"  // This regex pattern will match any collection that starts with "lightrag_"
    ]
  }
};
