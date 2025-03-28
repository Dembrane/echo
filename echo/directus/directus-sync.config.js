module.exports = {
  // this is assuming we are in the dev container. which means that
  // this NEEDS to be done after the build is complete
  // OR needs to be run in the same container as the directus server
  dumpPath: './sync',
  preserveIds: ['roles', 'policies', 'dashboards', 'panels'],
  exclude: {
    collections: [
      /lightrag_.*/  // This regex pattern will match any collection that starts with "lightrag_"
    ]
  }
};
