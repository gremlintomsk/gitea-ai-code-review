#!/usr/bin/env bash
# One-shot setup: gitea + runner + demo java repo + demo PR.
# Idempotent enough to re-run after `docker compose down -v`.
set -euo pipefail
cd "$(dirname "$0")"

ADMIN_USER=gitea_admin
ADMIN_PASS=gitea12345
ADMIN_EMAIL=admin@local.test
REPO=java-demo
GITEA_URL=http://localhost:3000
# Ключ OpenRouter для AI-ревью (https://openrouter.ai/settings/keys).
# Передаётся окружением: OPENROUTER_API_KEY=sk-or-v1-... ./setup.sh
# Можно и вписать значение прямо сюда, но не коммитьте скрипт с ключом.
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"

echo "==> starting gitea"
touch .env
docker compose up -d gitea
until docker compose exec gitea curl -fsS http://localhost:3000/api/healthz >/dev/null 2>&1; do sleep 2; done

echo "==> ensuring admin user"
docker compose exec -u git gitea gitea admin user create --admin \
  --username "$ADMIN_USER" --password "$ADMIN_PASS" --email "$ADMIN_EMAIL" \
  --must-change-password=false 2>/dev/null || echo "(admin already exists)"

echo "==> registering runner"
RUNNER_TOKEN=$(docker compose exec -u git gitea gitea actions generate-runner-token | tr -d '\r\n')
echo "RUNNER_TOKEN=$RUNNER_TOKEN" > .env
docker compose up -d runner

echo "==> creating repo $REPO"
curl -fsS -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$GITEA_URL/api/v1/user/repos" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$REPO\",\"default_branch\":\"main\"}" >/dev/null 2>&1 || echo "(repo already exists)"

echo "==> pushing demo project"
TMP=$(mktemp -d)
cp -r "$PWD/$REPO/." "$TMP/"
git -C "$TMP" init -q -b main
git -C "$TMP" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_EMAIL" add -A
git -C "$TMP" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_EMAIL" commit -qm "feat: java demo with CI and AI review workflow"
git -C "$TMP" push -q "http://$ADMIN_USER:$ADMIN_PASS@localhost:3000/$ADMIN_USER/$REPO.git" main -f

if [ -n "$OPENROUTER_API_KEY" ]; then
  echo "==> installing OPENROUTER_API_KEY secret"
  curl -fsS -u "$ADMIN_USER:$ADMIN_PASS" -X PUT \
    "$GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO/actions/secrets/OPENROUTER_API_KEY" \
    -H 'Content-Type: application/json' -d "{\"data\":\"$OPENROUTER_API_KEY\"}"
else
  echo "==> OPENROUTER_API_KEY не задан — AI-ревью будет постить в PR подсказку вместо ревью"
fi

echo "==> opening a demo PR to trigger the review"
git -C "$TMP" checkout -qb feature/email-validation
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
git -C "$TMP" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_EMAIL" add -A
git -C "$TMP" -c user.name="$ADMIN_USER" -c user.email="$ADMIN_EMAIL" commit -qm "feat: naive email validation"
git -C "$TMP" push -q "http://$ADMIN_USER:$ADMIN_PASS@localhost:3000/$ADMIN_USER/$REPO.git" feature/email-validation -f
sleep 3
curl -fsS -u "$ADMIN_USER:$ADMIN_PASS" -X POST "$GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO/pulls" \
  -H 'Content-Type: application/json' \
  -d '{"title":"feat: naive email validation","head":"feature/email-validation","base":"main"}' >/dev/null 2>&1 || echo "(PR already exists)"
rm -rf "$TMP"

echo
echo "Done."
echo "  UI:    $GITEA_URL  ($ADMIN_USER / $ADMIN_PASS)"
echo "  Repo:  $GITEA_URL/$ADMIN_USER/$REPO"
if [ -n "$OPENROUTER_API_KEY" ]; then
  echo "  AI review: enabled (OPENROUTER_API_KEY secret installed)"
else
  echo "  AI review: key NOT set. Add it later with:"
  echo "  curl -u $ADMIN_USER:$ADMIN_PASS -X PUT $GITEA_URL/api/v1/repos/$ADMIN_USER/$REPO/actions/secrets/OPENROUTER_API_KEY -H 'Content-Type: application/json' -d '{\"data\":\"sk-or-...\"}'"
fi
