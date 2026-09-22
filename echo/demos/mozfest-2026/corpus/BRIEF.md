# Brief for one synthetic MozFest 2026 harvest conversation

You are writing ONE invented conversation for a clearly labelled synthetic dembrane demo. dembrane is listening software: people talk in small groups, it transcribes, and a live facilitator screen ("popcorn") pops short phrases from what was said, then finds tensions between rooms and a map of stakeholders. The demo imagines dembrane as listening infrastructure across MozFest 2026 (Mozilla Festival, Recinte Fabra i Coats, Sant Andreu, Barcelona, Wednesday October 28 to Friday October 30 2026; theme "Wilding": loosening rigid, centralised, extractive tech so communities and technologies can grow wilder, more diverse, more alive; community-owned mesh networks, federated platforms, open protocols, community archives, tools built on transparency, trust and mutual flourishing).

Format of the scenario: after a session in a track room, 4 to 6 people who attended stay behind for a 15-to-20 minute "harvest" conversation around a phone on the table. A volunteer harvester opens with a short intro and asks two or three open questions, for example "What did you hear in there that you want the whole festival to hear?", "What are you wilding, and what's in the way?", "What should MozFest carry home?". The hallway screens show the question "What are we wilding?".

## Hard rules

- Fully fictional. Invent every person (first names only, varied origins), every project, collective, city-neighbourhood initiative, startup and product. NO real people (no speakers, no Mozilla staff, no public figures), NO real organisations, companies, NGOs, foundations, apps, platforms or products by name (say "an encrypted messenger", "a federated server", "a big cloud provider", "a hyperscaler", "a big model lab"). Mozilla/MozFest, Barcelona, Sant Andreu, Fabra i Coats and the track names may appear only as the setting. Never claim what the festival organisers think or decided. Never quote or paraphrase a real talk.
- Raw spoken transcript: NO speaker labels, no stage directions, no timestamps. Disfluencies, false starts, people interrupting and building on each other, laughter written as words only when spoken ("ha, okay"), someone trailing off. People introduce themselves by first name early on, as people do.
- Concrete over abstract: specific (invented) stories, places, numbers, objects, failures. A mesh node on a roof that died in a heatwave beats "infrastructure is fragile".
- Real disagreement, left unresolved where it is unresolved. Nobody summarises the room neatly at the end. No consensus manufactured.
- Output is chunked like live transcription: each chunk 30 to 45 words, chunks sometimes cut mid-sentence and continue in the next. 45 to 55 chunks in total (about 1,700 to 2,200 words).
- The first chunk is exactly the room's synthetic label line given in your task, on its own, then the conversation starts in chunk two.

## Output

Write a single JSON file (UTF-8, no comments) at the path in your task:

{
  "id": "<id from task>",
  "label": "<label from task>",
  "track": "<track from task>",
  "language": "<language code from task>",
  "start": "<ISO timestamp from task>",
  "chunks": ["...", "..."]
}

Validate it with `python3 -c "import json,sys;d=json.load(open(sys.argv[1]));c=d['chunks'];w=[len(x.split()) for x in c];print(len(c),'chunks',sum(w),'words',min(w),max(w))" <path>` and fix anything outside the limits (first chunk excepted).

Then reply with: the chunk and word counts, the arc in three lines, and the six lines you would expect a listener to remember, verbatim from your transcript.
