#!/usr/bin/env bash
# One-shot setup: gitea + runner + demo java repo + demo PR.
# Idempotent enough to re-run after `docker compose down -v`.
set -euo pipefail
cd "$(dirname "$0")"

# Overridable via environment, sane local defaults:
#   ADMIN_PASS=... OPENROUTER_API_KEY=sk-or-v1-... ./setup.sh
ADMIN_USER="${ADMIN_USER:-gitea_admin}"
ADMIN_PASS="${ADMIN_PASS:-gitea12345}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@local.test}"
REPO=java-demo
GITEA_URL=http://localhost:3000
PR_BRANCH=feature/email-validation
# Ключ OpenRouter для AI-ревью (https://openrouter.ai/settings/keys).
# Передаётся окружением: OPENROUTER_API_KEY=sk-or-v1-... ./setup.sh
# Можно и вписать значение прямо сюда, но не коммитьте скрипт с ключом.
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"

# Never leave the temp clone (it has credentials in its git remote) behind.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

auth=(-u "$ADMIN_USER:$ADMIN_PASS")

echo "==> starting gitea"
touch .env
chmod 600 .env
docker compose up -d gitea
# Wait for health with a timeout instead of hanging forever.
for _ in $(seq 1 90); do
  docker compose exec gitea curl -fsS http://localhost:3000/api/healthz >/dev/null 2>&1 && break
  sleep 2
done
docker compose exec gitea curl -fsS http://localhost:3000/api/healthz >/dev/null \
  || { echo "gitea did not become healthy in 3 minutes — check: docker compose logs gitea" >&2; exit 1; }

echo "==> ensuring admin user"
docker compose exec -u git gitea gitea admin user create --admin \
  --username "$ADMIN_USER" --password "$ADMIN_PASS" --email "$ADMIN_EMAIL" \
  --must-change-password=false 2>/dev/null || echo "(admin already exists)"

echo "==> registering runner"
RUNNER_TOKEN=$(docker compose exec -u git gitea gitea actions generate-runner-token | tr -d '\r\n')
echo "RUNNER_TOKEN=$RUNNER_TOKEN" > .env
docker compose up -d runner

# Create only if missing (a bare `|| echo` would mask real API errors too).
ensure_repo() {
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO")
  if [ "$status" = 404 ]; then
    curl -fsS "${auth[@]}" -X POST "$GITEA_URL/api/v1/user/repos" \
      -H 'Content-Type: application/json' \
      -d "{\"name\":\"$REPO\",\"default_branch\":\"main\"}" >/dev/null
  elif [ "$status" != 200 ]; then
    echo "checking repo $REPO failed (HTTP $status)" >&2; exit 1
  else
    echo "(repo already exists)"
  fi
}
ensure_repo

echo "==> pushing demo project"
cp -r "$PWD/$REPO/." "$TMP/"
git -C "$TMP" init -q -b main
git -C "$TMP" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_EMAIL" add -A
git -C "$TMP" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_EMAIL" commit -qm "feat: java demo with CI and AI review workflow"
git -C "$TMP" push -q "http://$ADMIN_USER:$ADMIN_PASS@localhost:3000/$ADMIN_USER/$REPO.git" main -f

install_secret() {
  curl -fsS "${auth[@]}" -X PUT \
    "$GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO/actions/secrets/OPENROUTER_API_KEY" \
    -H 'Content-Type: application/json' -d "{\"data\":\"$OPENROUTER_API_KEY\"}" >/dev/null
  echo "OPENROUTER_API_KEY installed."
}
if [ -n "$OPENROUTER_API_KEY" ]; then
  echo "==> installing OPENROUTER_API_KEY secret"
  install_secret
else
  echo "==> OPENROUTER_API_KEY не задан — AI-ревью будет постить в PR подсказку вместо ревью"
fi

echo "==> opening a demo PR to trigger the review"
cat > "$TMP/src/EmailUtils.java" <<'EOF'
public class EmailUtils {
    public static boolean isValid(String email) {
        try {
            return email.split("@")[1].length() > 0;
        } catch (Exception e) {
            return false;
        }
    }
}
EOF
git -C "$TMP" checkout -qb "$PR_BRANCH"
git -C "$TMP" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_EMAIL" add -A
git -C "$TMP" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_EMAIL" commit -qm "feat: naive email validation"
git -C "$TMP" push -q "http://$ADMIN_USER:$ADMIN_PASS@localhost:3000/$ADMIN_USER/$REPO.git" "$PR_BRANCH" -f

# Wait until Gitea actually sees the branch (no blind `sleep 3`).
for _ in $(seq 1 30); do
  status=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" \
    "$GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO/branches/$PR_BRANCH")
  [ "$status" = 200 ] && break
  sleep 1
done

# Create the PR only if this branch doesn't have an open one yet.
PR_EXISTS=$(curl -fsS "${auth[@]}" "$GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO/pulls?state=open&limit=50" \
  | tr ',' '\n' | grep -c "\"ref\": \"refs/heads/$PR_BRANCH\"" || true)
if [ "$PR_EXISTS" = 0 ]; then
  curl -fsS "${auth[@]}" -X POST "$GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO/pulls" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"feat: naive email validation\",\"head\":\"$PR_BRANCH\",\"base\":\"main\"}" >/dev/null
else
  echo "(PR for $PR_BRANCH already exists)"
fi

echo
echo "Done."
echo "  UI:    $GITEA_URL  ($ADMIN_USER / $ADMIN_PASS)"
echo "  Repo:  $GITEA_URL/$ADMIN_USER/$REPO"
if [ -n "$OPENROUTER_API_KEY" ]; then
  echo "  AI review: enabled (OPENROUTER_API_KEY secret installed)"
else
  echo "  AI review: key NOT set. Add it later with:"
  echo "  curl -u $ADMIN_USER:$ADMIN_PASS -X PUT $GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO/actions/secrets/OPENROUTER_API_KEY -H 'Content-Type: application/json' -d '{\"data\":\"sk-or-...\"}'"
  echo "  then re-run the review: Actions → AI Code Review → Run workflow (PR number: 1)."
fi
