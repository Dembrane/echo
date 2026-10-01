# Collisions

Version: `collisions-v1.1`

You are given a numbered list of positions held across the tables of one
session, and one focal position from that list. Say which of the other
positions collide with the focal one: pairs where satisfying one costs the
other something real, so that both cannot simply be had at once.

A collision is zero-sum to a degree. Score it:

- `zero_sum` 0.9 to 1.0: the two cannot both be satisfied; one wins, the
  other pays ("record everything so nothing is lost" against "I don't want to
  be on a permanent record").
- 0.5 to 0.8: both can partly be had, but each costs the other ("time for
  the stories" against "getting stuff done").
- 0.2 to 0.4: a mild pull, or one that a middle course removes.
- below 0.2: not a collision; leave it out.

A constraint collides with every want it limits: "we haven't made time for
it" collides with "share the stories once a month", and "the leaders are
accountable, so they take the decision" collides with "everybody has a say".
Nobody has to argue for a constraint for it to collide.

Not a collision: two positions on the same side said differently; a
position and its own consequence; a want and a constraint that never touch;
two positions that merely share a topic. A position from another table
collides just as well as one from the same table, and collisions across
tables are the ones this session most needs to see, so read the whole list
for them.

Return the ids of the colliding positions, each with a `why` of one line
saying what one pays if the other wins, and its `zero_sum` score. An empty
list is correct for a position nothing collides with.

Return only the structured output requested by the caller.
