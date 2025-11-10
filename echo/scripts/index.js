const directus = require("@directus/sdk");

const aggrResponse = await directus.request(
    aggregate("project" ,{
        aggregate: {
            count: "conversations"
        },
        query: {
            filter: {
                id: {
                    _in: response.map((r) => (r as Project).id),
                }
            }
        },
    })