# Gitea + Actions Runner + AI Code Review

Локальный стенд: Gitea с CI (Gitea Actions, совместимы с GitHub Actions) и
AI-ревью пул-реквестов бесплатными моделями через OpenRouter.

```
                gitea-net (docker network)
 ┌──────────┐      ┌────────────┐      ┌─────────────────────┐
 │  gitea   │◄─────│ act_runner │─────►│ job: node:20        │
 │  :3000   │      │ (docker    │      │ review.mjs ────────►│──► openrouter.ai
 │          │      │  sock)     │      │ (checkout + node)   │      (или Ollama)
 └──────────┘      └────────────┘      └─────────────────────┘
```

## Состав

| Файл | Назначение |
|---|---|
| `docker-compose.yml` | Gitea 28.2 (порт 3000) + act_runner 0.6.1 (label `ubuntu-latest` → `node:20-bookworm`) |
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

Логин/пароль админа и порт переопределяются окружением:
`ADMIN_USER=... ADMIN_PASS=... ./setup.sh` (дефолты — `gitea_admin`/`gitea12345`).

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
кредитов на $10). Расход токенов печатается в лог джобы и в шапке комментария
ревью — за лимитом удобно следить.

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

## Как устроено ревью

`java-demo/.gitea/workflows/review.yml` на каждый PR (и вручную) запускает
`.gitea/scripts/review.mjs`, который:

1. забирает метаданные PR и дифф через Gitea API (авторизация встроенным
   `GITHUB_TOKEN`); дифф чистится от шума (lock-файлы, минифицированный и
   генерированный код);
2. режет большие диффы на чанки (60k символов на чанк) — хвост диффа больше
   не теряется молча;
3. идёт по цепочке бесплатных моделей OpenRouter, пока одна не ответит
   (free-модели периодически перегружены или снимаются с раздачи):
   `nvidia/nemotron-3-super-120b-a12b:free → openai/gpt-oss-20b:free →
   google/gemma-4-31b-it:free → z-ai/glm-5.2:free`,
   по каждой до 3 попыток с бэкоффом (сеть/429/5xx) и с таймаутом запроса;
4. просит у модели **структурированный JSON** (вердикт + находки с
   file/severity/line) и валидирует ответ;
5. результат постит в PR:
   - **один обновляемый комментарий-сводка** (не новый на каждый пуш — свой
     прошлый комментарий редактируется);
   - **инлайн-замечания** на конкретные строки диффа (отдельным review;
     старые перед этим удаляются);
   - **commit status** `ai-code-review`: `failure`, если найдены блокеры —
     можно подключить в branch protection и реально блокировать мерж.

Что ещё умеет из коробки:

- `[skip-ai-review]` в заголовке PR — пропустить ревью;
- `concurrency` в воркфлоу — новый пуш отменяет ревью предыдущего коммита;
- языки для промпта определяются по расширениям файлов в диффе (не только Java);
- `REVIEW_INLINE=false` (Variables) — отключить инлайн-комментарии, оставить
  только сводку.

### Настройка без правки кода

Всё через репозиторий → Settings → Actions → **Variables**:

| Variable | Что делает | Пример |
|---|---|---|
| `REVIEW_MODEL` | цепочка моделей через запятую (дефолт зашит только в `review.mjs`) | `deepseek/deepseek-chat-v3-0324,openai/gpt-oss-20b:free` |
| `REVIEW_BASE_URL` | любой OpenAI-совместимый эндпоинт — Ollama, vLLM, LM Studio (полностью оффлайн, без лимитов OpenRouter) | `http://ollama:11434/v1` |
| `REVIEW_INLINE` | `false` — без инлайн-комментариев | `false` |
| `REVIEW_FAIL_ON` | когда commit status красный: `blocker` (дефолт) — при любом блокере, `major` — при блокерах или важных, `never` — всегда зелёный (информационный) | `never` |
| `REVIEW_PUBLIC_URL` | публичный origin для абсолютных ссылок (нужен статусу коммита), если CI ходит в Gitea по внутреннему хосту | `http://gitea.example.com` |

Секрет `OPENROUTER_API_KEY` при использовании своего `REVIEW_BASE_URL` не нужен
(для Ollama подойдет любое непустое значение-заглушка, например `dummy`).

## Как перезапустить ревью вручную

Например, после добавления секрета в уже открытый PR:

1. **UI (проще всего):** репозиторий → Actions → **AI Code Review** →
   **Run workflow** → указать номер PR (например, `1`).
2. **API:** у воркфлоу есть `workflow_dispatch`, так что и из скриптов:
   ```bash
   # найти ID воркфлоу
   curl -u gitea_admin:gitea12345 \
     http://localhost:3000/api/v1/repos/gitea_admin/java-demo/actions/workflows | jq '.workflows[] | {id,name}'
   # запустить (ref — ветка, где лежит воркфлоу, т.е. PR-ветка или main)
   curl -u gitea_admin:gitea12345 -X POST \
     http://localhost:3000/api/v1/repos/gitea_admin/java-demo/actions/workflows/<ID>/dispatches \
     -H 'Content-Type: application/json' -d '{"ref":"main","inputs":{"pr_number":"1"}}'
   ```
3. **Пустой коммит в PR-ветку:**
   ```bash
   git commit --allow-empty -m "retrigger review" && git push
   ```

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

## Безопасность

- Раннер маунтит `/var/run/docker.sock` — это фактически root на хосте.
  Для локальной демки приемлемо, для общего сервера так делать нельзя
  (смотрите в сторону rootless Docker / DinD).
- Ключ OpenRouter хранится только внутри Gitea (volume `gitea-data`) как
  write-only секрет — прочитать его назад через API/UI нельзя, в файлах стенда
  он не сохраняется. `down -v` уничтожает его вместе с volume.
- `setup.sh` создаёт `.env` с `RUNNER_TOKEN` (права 600) — это одноразовый токен
  регистрации раннера, после регистрации он бесполезен; после `down -v` файл
  можно (и стоит) удалить.
- Если передавали ключ как `OPENROUTER_API_KEY=... ./setup.sh`, он мог осесть
  в истории shell (`history -d` / `HISTCONTROL=ignorespace` в помощь).
- Помните, что дифф — недоверенный ввод: код в PR может попытаться
  «проинструктировать» модель (prompt injection). Ревью только постит текст в PR,
  но читайте его ответ с той же настороженностью, что и сам код.
