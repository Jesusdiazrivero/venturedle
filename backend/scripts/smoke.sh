#!/usr/bin/env bash
#
# Plays one full game against a running backend: anonymous player → start → wrong guess → right
# guess → share text. Run it after `npm run dev -w backend` (or against a deployed box):
#
#   backend/scripts/smoke.sh
#   BASE_URL=https://venturedle.example.com COMPANIES_FILE=data/companies.json backend/scripts/smoke.sh
#
# The answer is read from the schedule file, which is why this is a smoke test and not a game.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
COMPANIES_FILE="${COMPANIES_FILE:-data/companies.example.json}"
NICKNAME="${NICKNAME:-smoke-$$}"

# node is already a hard requirement, so nothing here needs jq.
field() {
  node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      const value = process.argv[1]
        .split(".")
        .reduce((o, k) => (o == null ? o : o[k]), JSON.parse(raw));
      if (value === undefined) {
        console.error(`no "${process.argv[1]}" in ${raw}`);
        process.exit(1);
      }
      process.stdout.write(String(value));
    });
  ' "$1"
}

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

step "1. today's puzzle"
puzzle=$(curl -fsS "$BASE_URL/api/puzzle/today") || {
  echo "cannot reach $BASE_URL — is the backend running?" >&2
  exit 1
}
echo "$puzzle"
date=$(printf '%s' "$puzzle" | field date)
if [ "$(printf '%s' "$puzzle" | field exists)" != "true" ]; then
  echo "nothing scheduled for $date — run \`npm run example-schedule\` or set DEV_TODAY" >&2
  exit 1
fi

read -r answer wrong <<EOF
$(node -e '
  const { companies } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const answer = companies.find((c) => c.date === process.argv[2]);
  if (!answer) {
    console.error(`${process.argv[1]} has no company on ${process.argv[2]}`);
    process.exit(1);
  }
  console.log(answer.id, companies.find((c) => c.id !== answer.id).id);
' "$COMPANIES_FILE" "$date")
EOF

step "2. anonymous player \"$NICKNAME\""
token=$(curl -fsS -X POST "$BASE_URL/api/auth/anonymous" \
  -H 'Content-Type: application/json' -d "{\"nickname\":\"$NICKNAME\"}" | field token)
auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')

step "3. start the clock"
curl -fsS -X POST "$BASE_URL/api/results/today/start" "${auth[@]}" | field status
echo

step "4. wrong guess ($wrong)"
curl -fsS -X POST "$BASE_URL/api/results/today/guesses" "${auth[@]}" \
  -d "{\"companyId\":\"$wrong\"}" | field guesses.0.correct
echo

step "5. right guess ($answer)"
state=$(curl -fsS -X POST "$BASE_URL/api/results/today/guesses" "${auth[@]}" \
  -d "{\"companyId\":\"$answer\"}")
status=$(printf '%s' "$state" | field status)
echo "$status"
[ "$status" = "solved" ] || { echo "expected status=solved" >&2; exit 1; }

step "share text"
printf '%s' "$state" | field shareText
echo
