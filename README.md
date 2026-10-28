# Gitea + Actions Runner + AI Code Review

Локальный стенд: Gitea с CI (Gitea Actions, совместимы с GitHub Actions) и
AI-ревью пул-реквестов бесплатными моделями через OpenRouter. Разворачивается
одним скриптом, ревью работает из коробки.

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

# или без ключа (ревью постит в PR подсказку, как добавить ключ):
./setup.sh
```

Скрипт поднимает Gitea, создаёт админа, регистрирует раннер, создаёт
репозиторий `java-demo`, пушит код, (опционально) ставит секрет и открывает
demo-PR — на нём сразу запускаются CI и AI-ревью.

Логин/пароль админа переопределяются окружением:
`ADMIN_USER=... ADMIN_PASS=... ./setup.sh` (дефолты — `gitea_admin`/`gitea12345`).

После запуска:

- UI: http://localhost:3000 — логин `gitea_admin`, пароль `gitea12345`
- Репозиторий: http://localhost:3000/gitea_admin/java-demo
- Demo-PR с ревью: http://localhost:3000/gitea_admin/java-demo/pulls/1

## Ключ OpenRouter

**Где взять (бесплатно):**

1. Зарегистрируйтесь на https://openrouter.ai (GitHub/Google, карта не нужна).
2. https://openrouter.ai/settings/keys → **Create Key** → скопируйте `sk-or-v1-...`
   (показывается один раз).
3. В **Settings → Privacy** включите «Enable free endpoints» — иначе
   `:free`-модели возвращают 404.

Лимит бесплатного тира: ~50 запросов/день (1000/день, если разово купить
кредитов на $10). Расход токенов печатается в лог джобы и в шапке комментария
ревью — за лимитом удобно следить.

**Куда положить:**

- при развёртывании: `OPENROUTER_API_KEY=... ./setup.sh`;
- в работающий стенд через UI: репозиторий → **Settings → Actions → Secrets** →
  `OPENROUTER_API_KEY`;
- через API:

```bash
curl -u gitea_admin:gitea12345 -X PUT \
  http://localhost:3000/api/v1/repos/gitea_admin/java-demo/actions/secrets/OPENROUTER_API_KEY \
  -H 'Content-Type: application/json' -d '{"data":"sk-or-v1-ВАШ_КЛЮЧ"}'
```

## Как выглядит ревью

```markdown
🤖 AI Code Review: 🚨 **Требуются правки** — 4 замечания · `nvidia/...` · ~1.0k токенов

Валидация email наивна; сравнение строк через `==`.

#### 📄 src/EmailUtils.java
- L4 🚨 `a@b`, `a@` и `@b` без локальной части считаются валидными → регулярка/валидатор
- L6 ⚠️ `catch (Exception)` глотает всё, включая NPE → явная проверка null/contains
- L3 💬 `isValid(null)` идёт через исключение → ранний `return false`

#### 🧷 Без привязки к строке
- ⚠️ `src/UserService.java:21` — сравнение строк через `==` → `.equals(name)`
```

Результат появляется в трёх местах:

1. **Комментарий-сводка** — один на весь PR, обновляется при каждом пуше
   (новых комментариев не плодит). Замечания сгруппированы по файлам,
   `L4` — кликабельная ссылка на строку диффа.
2. **Инлайн-замечания** — отдельным review прямо на строках кода
   (`🤖 🚨 BLOCKER — …`); старые перед каждым запуском удаляются.
3. **Commit status** `ai-code-review` — светофор для branch protection
   (когда красный — настраивается, см. `REVIEW_FAIL_ON` ниже).

Вердикты: 🚨 Требуются правки / ⚠️ Есть замечания / ✅ Можно мержить.
`[skip-ai-review]` в заголовке PR отключает ревью для этого PR.

## Как устроено ревью

`review.yml` запускается на каждый PR (`opened`/`synchronize`/`reopened`) и
вручную (`workflow_dispatch`). Скрипт `.gitea/scripts/review.mjs`:

1. забирает метаданные PR и дифф через Gitea API (авторизация встроенным
   `GITHUB_TOKEN`);
2. чистит дифф от шума (lock-файлы, минифицированный и генерированный код)
   и режет на чанки по 60k символов — хвост большого диффа не теряется;
3. идёт по цепочке моделей, пока одна не ответит: по каждой до 3 попыток
   с бэкоффом (сеть/429/5xx) и таймаутом. Дефолтная цепочка бесплатных
   моделей зашита в `review.mjs`, у каждой следующей чанк сперва пробует
   модель, сработавшую на предыдущей;
4. просит у модели **структурированный JSON** (вердикт + находки
   `file/line/severity/message/suggestion`), валидирует ответ и «прилипает»
   номера строк к реальным изменённым (`+`) строкам диффа;
5. постит сводку, инлайн-замечания и commit status (см. выше).

Языки для промпта определяются по расширениям файлов в диффе — ревью не
Java-специфично. `concurrency` в воркфлоу отменяет ревью предыдущего коммита
при новом пуше.

## Настройка без правки кода

Secrets и Variables: репозиторий → Settings → Actions.

**Secrets:**

| Secret | Зачем |
|---|---|
| `OPENROUTER_API_KEY` | ключ OpenRouter. Не нужен при своём `REVIEW_BASE_URL` (для Ollama достаточно заглушки `dummy`) |

**Variables:**

| Variable | Что делает | По умолчанию |
|---|---|---|
| `REVIEW_MODEL` | цепочка моделей через запятую | зашита в `review.mjs` |
| `REVIEW_BASE_URL` | любой OpenAI-совместимый эндпоинт: Ollama, vLLM, LM Studio (оффлайн, без лимитов OpenRouter) | `https://openrouter.ai/api/v1` |
| `REVIEW_INLINE` | `false` — только сводка, без инлайн-комментариев | `true` |
| `REVIEW_FAIL_ON` | когда статус `ai-code-review` красный: `blocker` — при любом блокере; `major` — при блокерах или важных; `never` — всегда зелёный | `blocker` |
| `REVIEW_PUBLIC_URL` | публичный origin для абсолютных ссылок статуса, если CI ходит в Gitea по внутреннему хосту | — |

**Блокировка мержа по ревью:** Settings → Branches → Protect `main` →
required status check `ai-code-review`. При `REVIEW_FAIL_ON=blocker`/`major`
Gitea не даст смержить PR с красным статусом.

## Как перезапустить ревью вручную

Например, после добавления секрета в уже открытый PR:

- **UI:** Actions → **AI Code Review** → **Run workflow** → номер PR;
- **API** (ID воркфлоу — имя файла):

```bash
curl -u gitea_admin:gitea12345 -X POST \
  http://localhost:3000/api/v1/repos/gitea_admin/java-demo/actions/workflows/review.yml/dispatches \
  -H 'Content-Type: application/json' -d '{"ref":"main","inputs":{"pr_number":"1"}}'
```

- **Пустой коммит** в PR-ветку: `git commit --allow-empty -m retrigger && git push`.

## Управление стендом

```bash
docker compose down         # остановить (данные сохраняются)
docker compose up -d        # запустить снова после обычного down
docker compose down -v      # остановить и стереть всё (репо, пользователей, секреты, кэш)
./setup.sh                  # развернуть с нуля — единственный путь после down -v
docker logs -f gitea-runner # логи раннера
```

После `down -v` регистрация раннера и секрет с ключом стираются — простое
`up -d` уже не поможет, запускайте `./setup.sh` и кладите ключ заново.

## Особенности этой сети

- `api.adoptium.net` (Temurin) и `api.azul.com` (Zulu) **недоступны** — CI
  ставит JDK через `setup-java` с `distribution: liberica`
  (`api.bell-sw.com` доступен). С Temurin шаг зависает навсегда.
- До `openrouter.ai` изредка рвётся TLS (ECONNRESET) — ретраи в скрипте
  это закрывают.

## Безопасность

- Раннер маунтит `/var/run/docker.sock` — это фактически root на хосте.
  Для локальной демки приемлемо, для общего сервера — нет
  (смотрите в сторону rootless Docker / DinD).
- Ключ OpenRouter хранится только внутри Gitea (volume `gitea-data`) как
  write-only секрет — прочитать его назад через API/UI нельзя, в файлах
  стенда он не сохраняется. `down -v` уничтожает его вместе с volume.
- `setup.sh` создаёт `.env` с `RUNNER_TOKEN` (права 600) — одноразовый токен
  регистрации раннера, после регистрации бесполезен; после `down -v` файл
  можно удалить.
- Ключ, переданный как `OPENROUTER_API_KEY=... ./setup.sh`, может осесть в
  истории shell (`history -d` / `HISTCONTROL=ignorespace` в помощь).
- Дифф — недоверенный ввод: код в PR может «проинструктировать» модель
  (prompt injection). Ревью только постит текст, но читайте его с той же
  настороженностью, что и сам код.
