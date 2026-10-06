# The Slack messages ci-notify.sh and release.sh post to #alerts-ci, as chat.postMessage
# payloads: blocks for the channel, and a plain text that reads well alone in a notification.
#
# Every message opens with the same few words (PR preview, Staging or Production environment,
# then created, updated, removed or not updated) and one fixed emoji per kind. Links are full
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

# An environment that was created or updated, from the PRs it carries: the title, its full
# link (two lines for a preview: dashboard, then portal), then each PR.
def environment($emoji; $head; $url; $max):
  {text: ([$head, $url, (if length == 0 then "No new pull requests." else prs_text($max) end)]
     | map(select(. != "")) | join("\n")),
   blocks: [header($emoji; $head), (if $url == "" then empty else section($url) end),
     (if length == 0 then section("No new pull requests.") else prs_blocks($max) end)]};

# An environment that was not updated: one sentence saying what stopped it, then the run's link.
# The input is the PR of a preview, or nothing.
def stopped($head; $sentence; $run):
  {text: ([$head, $sentence, $run, prs_text(1)] | map(select(. != "")) | join("\n")),
   blocks: [header(":warning:"; $head), section($sentence), context($run), prs_blocks(1)]};

# A line in a preview's thread: what happened, a short detail, and the run's link.
def reply($emoji; $head; $detail; $run):
  {text: ([$head + (if $detail == "" then "" else ": \($detail)" end), $run] | map(select(. != "")) | join("\n")),
   blocks: [section("\($emoji) *\($head)*" + (if $detail == "" then "" else "  \($detail)" end)), context($run)]};

# What stopped a run, from its failed jobs ({name, step}): the kind of work in plain words and
# the step it stopped at.
def reasons:
  def plain: {"plan": "planning the run", "check-server": "server checks", "check-frontend": "frontend checks",
    "test-frontend": "frontend tests", "build-images": "the build", "images": "the build",
    "deploy-pr-preview": "the deploy", "deploy-pr": "the deploy", "deploy-staging": "the deploy",
    "deploy-prod": "the deploy", "teardown-pr-preview": "the removal", "teardown-pr": "the removal"};
  if length == 0 then "The run failed"
  else map((plain[.name | sub("^[0-9]+-"; "")] // (.name | esc)) + " failed"
      + (if .step == "" then "" else " at \"\(.step | esc)\"" end))
    | join(" and ") | (.[0:1] | ascii_upcase) + .[1:]
  end;
