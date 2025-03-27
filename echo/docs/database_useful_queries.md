# Useful Queries

## Exporting a Project's Conversations to JSON (with tags)

```sql
\copy (
    SELECT jsonb_build_object(
        'project_id', p.id,
        'conversation_created_at', c.created_at,
        'conversation_id', c.id,
        'conversation_name', c.participant_name,
        'conversation_user_agent', c.participant_user_agent,
        'conversation_tags', (
            SELECT jsonb_agg(jsonb_build_object(
                'tag_id', pt.id,
                'tag_name', pt.text
            ))
            FROM project_conversation_tag_association pcta
            JOIN project_tag pt ON pt.id = pcta.project_tag
            WHERE pcta.conversation_id = c.id
        ),
        'conversation_transcript', (
            SELECT string_agg(sub.transcript, '\n')
            FROM (
                SELECT cc.transcript
                FROM conversation_chunk cc
                WHERE cc.conversation_id = c.id
                ORDER BY cc.created_at
            ) sub
        )
    )
    FROM project p
    JOIN conversation c ON c.project_id = p.id
    WHERE p.id = '458aadf7-72b0-4779-ad31-5a490d1f35bd'
) TO '/home/458aadf7-72b0-4779-ad31-5a490d1f35bd.json';
```

## Counting Conversations with Chunks

```sql
SELECT COUNT(DISTINCT c.id) AS conversations_with_chunks_count
FROM conversation c
JOIN conversation_chunk cc ON c.id = cc.conversation_id;
```

---

# Useful Database Commands

## Taking a snapshot of the database (`pg_dump`)

1. ssh into the server

2. psql shell commands
   replace `b70af5a57674` with the container id of the postgres container

```bash

docker exec -it b70af5a57674 /bin/sh

# in the container
pg_dump -U dembrane dembrane > 20240731.sql
exit

docker cp b70af5a57674:20240731.sql ./
```

3. copy to your local machine if needed using sftp/scp

## Restore a snapshot of the database (`pg_restore`)

```bash
# in the pgvector container after copying the file to the container
createdb -U dembrane dembrane
psql -U dembrane -d dembrane -f 20240731.sql
exit
```
