# Gitea + Actions Runner + AI Code Review

Локальный стенд: Gitea с CI (Gitea Actions, совместимы с GitHub Actions) и
AI-ревью пул-реквестов бесплатными моделями через OpenRouter.

## Состав

| Файл | Назначение |
|---|---|
| `docker-compose.yml` | Gitea 1.24 (порт 3000) + act_runner (label `ubuntu-latest` → `node:20-bookworm`) |
| `runner-config.yaml` | Конфиг раннера; job-контейнеры подключаются к сети `gitea-net` и видят `http://gitea:3000` |
| `setup.sh` | Разворачивает всё одним запуском (идемпотентный) |
| `java-demo/` | Демо Java-репозиторий: CI-сборка + воркфлоу AI-ревью |

## Быстрый старт

```bash
# с ключом OpenRouter (рекомендуется — ревью заработает сразу):
OPENROUTER_API_KEY=sk-or-v1-... ./setup.sh

# или без ключа (ревью будет постить в PR подсказку, как добавить ключ):
./setup.sh
```

Скрипт: поднимает Gitea → создаёт админа → регистрирует раннер → создаёт
репозиторий `java-demo`, пушит код → (опц.) ставит секрет → открывает demo-PR,
на котором сразу запускаются CI и AI-ревью.

После запуска:
- UI: http://localhost:3000 — логин `gitea_admin`, пароль `gitea12345`
- Репозиторий: http://localhost:3000/gitea_admin/java-demo
- Demo-PR с ревью: http://localhost:3000/gitea_admin/java-demo/pulls/1

## Где взять токен (бесплатно)

1. Зарегистрируйтесь на https://openrouter.ai (GitHub/Google, карта не нужна).
2. https://openrouter.ai/settings/keys → **Create Key** → скопируйте `sk-or-v1-...`
   (показывается один раз).
3. В **Settings → Privacy** включите «Enable free endpoints» — иначе
   `:free`-модели возвращают 404.

Лимит бесплатного тира: ~50 запросов/день (1000/день, если разово купить
кредитов на $10).

## Куда положить токен

Вариант A — при развёртывании: `OPENROUTER_API_KEY=... ./setup.sh` (см. выше).

Вариант B — в уже работающий стенд, через API:

```bash
curl -u gitea_admin:gitea12345 -X PUT \
  http://localhost:3000/api/v1/repos/gitea_admin/java-demo/actions/secrets/OPENROUTER_API_KEY \
  -H 'Content-Type: application/json' -d '{"data":"sk-or-v1-ВАШ_КЛЮЧ"}'
```

Вариант C — через UI: репозиторий → **Settings → Actions → Secrets** →
`OPENROUTER_API_KEY`.

Проверка: пустой коммит в ветку `feature/email-validation` (или любой пуш в
PR-ветку) → в PR #1 появится комментарий «🤖 AI Code Review».

## Как устроено ревью

`java-demo/.gitea/workflows/review.yml` на каждый PR запускает
`.gitea/scripts/review.mjs`, который:

1. забирает дифф PR через Gitea API (авторизация встроенным `GITHUB_TOKEN`);
2. идёт по цепочке бесплатных моделей OpenRouter, пока одна не ответит
   (free-модели периодически перегружены или снимаются с раздачи):
   `nvidia/nemotron-3-super-120b-a12b:free → openai/gpt-oss-20b:free →
   google/gemma-4-31b-it:free → z-ai/glm-5.2:free`,
   по каждой до 3 попыток с бэкоффом (сеть/429/5xx);
3. постит результат комментарием в PR.

Сменить модели без правки кода: репозиторий → Settings → Actions → **Variables**
→ `REVIEW_MODEL` — список через запятую, например
`deepseek/deepseek-chat-v3-0324,openai/gpt-oss-20b:free` (платная модель без
`:free` — копейки за дифф и без лотереи фритира).

## Как перезапустить ревью вручную

Например, после добавления секрета в уже открытый PR:

1. **UI:** репозиторий → Actions → открыть ран «AI Code Review» → **Re-run all jobs**.
2. **API (close/reopen PR):**
   ```bash
   curl -u gitea_admin:gitea12345 -X PATCH http://localhost:3000/api/v1/repos/gitea_admin/java-demo/pulls/1 \
     -H 'Content-Type: application/json' -d '{"state":"closed"}'
   curl -u gitea_admin:gitea12345 -X PATCH http://localhost:3000/api/v1/repos/gitea_admin/java-demo/pulls/1 \
     -H 'Content-Type: application/json' -d '{"state":"open"}'
   ```
3. **Пустой коммит в PR-ветку:**
   ```bash
   git commit --allow-empty -m "retrigger review" && git push
   ```

REST-эндпоинта rerun у Gitea нет — для скриптов используйте варианты 2–3.

## Особенности этой сети (важно)

- `api.adoptium.net` (Temurin) и `api.azul.com` (Zulu) **недоступны** — поэтому
  CI ставит JDK через `setup-java` с `distribution: liberica`
  (`api.bell-sw.com` доступен). С Temurin шаг зависает навсегда.
- До `openrouter.ai` изредка рвётся TLS (ECONNRESET) — ретраи в скрипте это
  закрывают.

## Управление

```bash
docker compose down         # остановить (данные сохраняются)
docker compose up -d        # запустить снова ПОСЛЕ обычного down
docker compose down -v      # остановить и стереть всё (репо, пользователей, секреты, кэш)
./setup.sh                  # развернуть с нуля — единственный путь после down -v
docker logs -f gitea-runner # логи раннера
```

После `down -v` регистрация раннера и секрет с ключом стираются — простое
`up -d` уже не поможет, запускайте `./setup.sh` (и кладите ключ заново).

## Где живут секреты

- Ключ OpenRouter хранится только внутри Gitea (volume `gitea-data`) как
  write-only секрет — прочитать его назад через API/UI нельзя, в файлах стенда
  он не сохраняется. `down -v` уничтожает его вместе с volume.
- `setup.sh` создаёт `.env` с `RUNNER_TOKEN` — это одноразовый токен
  регистрации раннера, после регистрации он бесполезен; после `down -v` файл
  можно (и стоит) удалить.
- Если передавали ключ как `OPENROUTER_API_KEY=... ./setup.sh`, он мог осесть
  в истории shell (`history -d` / `HISTCONTROL=ignorespace` в помощь).
