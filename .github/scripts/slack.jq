# The Slack messages ci-notify.sh and release.sh post to #alerts-ci, as chat.postMessage
# payloads: blocks for the channel, and a plain text that reads well alone in a notification.
#
# Every message opens with the same few words (PR preview, Staging or Production environment,
# then what happened to it) and one fixed emoji per kind. A message is posted when the work
# starts and edited in place when it ends, so it always shows the current state. Links are full
# URLs. A pull request is its title, the first paragraph of its description, and a small line
# with the author and the link.

# Text from a PR is shown as written: it cannot start a link, ping anyone, or end the bold
# around it. Cutting comes before escaping so an entity is never cut in half.
def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
def quiet: gsub("@(?=\\w)"; "@​");
def cut($n): if length > $n then .[0:$n] | sub("\\s+\\S*$"; "") + "…" else . end;
def trim1: sub("^ "; "") | sub(" $"; "");
def title: gsub("\\s+"; " ") | trim1 | gsub("\\*"; "∗") | gsub("`"; "'") | cut(150) | esc | quiet;

# The first paragraph of a PR description, on one line: no HTML comments, headings, tables,
# images, code fences or "Generated with" line, and links reduced to their text.
def describe:
  (. // "") | gsub("\r"; "") | gsub("<!--[\\s\\S]*?(-->|\\z)"; "")
  | [splits("\n") | sub("\\s+$"; "")
      | select(test("^\\s*(#|\\||```|!\\[|---+$)|Generated with \\[") | not)]
  | join("\n") | sub("^\\s+"; "") | (split("\n\n")[0] // "")
  | gsub("\\s+"; " ") | trim1 | gsub("!?\\[(?<t>[^\\]]*)\\]\\([^)]*\\)"; .t) | gsub("\\*\\*"; "*")
  | cut(300) | esc | quiet;

def header($emoji; $head): {type: "header", text: {type: "plain_text", text: "\($emoji) \($head)", emoji: true}};
def section($t): {type: "section", text: {type: "mrkdwn", text: $t}};
def context($t): if $t == "" then empty else {type: "context", elements: [{type: "mrkdwn", text: $t}]} end;

def pr_blocks:
  section("*\(.title | title)*" + ((.body | describe) as $d | if $d == "" then "" else "\n> \($d)" end)),
  context("\(.author | esc)  ·  \(.url)");
def pr_text: "• \(.title | title) (\(.author | esc)) \(.url)";
def prs_blocks($max):
  (reduce .[:$max][] as $pr ([]; (if length > 0 then . + [{type: "divider"}] else . end) + [$pr | pr_blocks])
    | .[]),
  (if length > $max then context("and \(length - $max) more") else empty end);
def prs_text($max): (.[:$max][] | pr_text), (if length > $max then "and \(length - $max) more" else empty end);

# An environment on its way: the PRs it will carry and the run doing the work.
def starting($head; $run; $max):
  {text: ([$head, (if length == 0 then "No new pull requests." else prs_text($max) end), $run]
     | map(select(. != "")) | join("\n")),
   blocks: [header(":hourglass_flowing_sand:"; $head),
     (if length == 0 then section("No new pull requests.") else prs_blocks($max) end), context($run)]};

# An environment that was created, updated or removed, from the PRs it carries: the title, a
# line under it (the full link, two lines for a preview: dashboard, then portal; for a removed
# preview, why), then each PR.
def environment($emoji; $head; $url; $max):
  {text: ([$head, $url, (if length == 0 then "No new pull requests." else prs_text($max) end)]
     | map(select(. != "")) | join("\n")),
   blocks: [header($emoji; $head), (if $url == "" then empty else section($url) end),
     (if length == 0 then section("No new pull requests.") else prs_blocks($max) end)]};

# An environment that was not updated: one sentence saying what stopped it, the run's link,
# then the PRs it would have carried, when they are known.
def stopped($head; $sentence; $run; $max):
  {text: ([$head, $sentence, $run, prs_text($max)] | map(select(. != "")) | join("\n")),
   blocks: [header(":warning:"; $head), section($sentence), context($run), prs_blocks($max)]};

# A line in a preview's thread: what happened, a short detail, and the run's link.
def reply($emoji; $head; $detail; $run):
  {text: ([$head + (if $detail == "" then "" else ": \($detail)" end), $run] | map(select(. != "")) | join("\n")),
   blocks: [section("\($emoji) *\($head)*" + (if $detail == "" then "" else "  \($detail)" end)), context($run)]};

# What stopped a run, the way a person would say it, from its failed jobs ({name, step}; a
# job is named by its id or its numbered name). This table is the one place that turns a
# workflow step into words: add a line when platform.yml gains a step that can fail. A step
# without a line is named as it is: "frontend checks failed at "Check path case"".
def reasons:
  def job: sub("^[0-9]+-"; "") | {"images": "build-images", "deploy-pr": "deploy", "deploy-pr-preview": "deploy",
    "deploy-staging": "deploy", "deploy-echo-next": "deploy", "deploy-prod": "deploy", "teardown-pr-preview": "teardown-pr"}[.] // .;
  def steps: {
    "check-server/Install dependencies": "the server dependencies did not install",
    "check-server/Lint and format": "the server code has lint or format errors",
    "check-server/Type check": "the code does not type-check",
    "check-server/Check config": "the server config is not valid",
    "check-server/Check package layers": "a server package breaks the layer rules",
    "check-server/Check schema matches migrations": "the database schema has a change without a migration",
    "check-server/Check the frontend's API types are in sync": "the API types are out of date",
    "check-server/Run tests": "a server test failed",
    "check-frontend/Install dependencies": "the frontend dependencies did not install",
    "check-frontend/Lint": "the frontend code has lint errors",
    "check-frontend/Type check": "the code does not type-check",
    "check-frontend/Check translations": "the translations are out of date",
    "check-frontend/Check API types are in sync": "the API types are out of date",
    "test-frontend/Install dependencies": "the frontend dependencies did not install",
    "test-frontend/Run tests": "a frontend test failed",
    "build-images/Build images": "an image failed to build",
    "build-images/Smoke test containers": "a built image did not start correctly",
    "build-images/Check portal bundle size": "the portal bundle is over its size budget",
    "deploy/Push images": "an image failed to build",
    "deploy/Authenticate to Google Cloud": "the deploy could not sign in to Google Cloud",
    "deploy/Log in to the DigitalOcean registry": "the deploy could not sign in to the image registry",
    "deploy/Update the image tag in echo-gitops": "the new image tag could not be written to echo-gitops",
    "deploy/Wait for the rollout": "the cluster did not serve the new commit within 15 minutes",
    "deploy/Deploy and verify": "the deploy did not pass its checks",
    "deploy/cancelled": "the deploy was cancelled"};
  def jobs: {"plan": "planning the run failed", "check-server": "server checks failed",
    "check-frontend": "frontend checks failed", "test-frontend": "frontend tests failed",
    "build-images": "the build failed", "deploy": "the deploy failed", "teardown-pr": "the removal failed"};
  if length == 0 then "The run failed"
  else [.[] | (.name | job) as $j
      | steps["\($j)/\(.step)"]
        // ((jobs[$j] // "\($j | esc) failed") + (if .step == "" then "" else " at \"\(.step | esc)\"" end))]
    | reduce .[] as $x ([]; if index($x) then . else . + [$x] end)
    | join(" and ") | (.[0:1] | ascii_upcase) + .[1:]
  end;
