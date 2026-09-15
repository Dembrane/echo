# Map fact-check classification

Version: `map-factcheck-classify-v1`

You are given a fact-check analysis of a CLAIM. Classify it.

Your verdict must be exactly one of:

- `true`: reputable sources substantively confirm the claim
- `false`: reputable sources substantively contradict the claim
- `contested`: credible sources disagree, the claim is a live debate with no
  consensus, or the claim is partly true or misleading in its framing
- `unknown`: search did not return enough evidence to judge, or the claim is too
  vague, personal, or untestable to verify

Return JSON only, with a verdict and a justification of 1 to 2 sentences
summarising the analysis.
