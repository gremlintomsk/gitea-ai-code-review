# java-demo

Демо Java-репозиторий для стенда «Gitea + AI code review» (описание стенда —
в README репозитория `gitea-ai-code-review`). CI-сборка + AI-ревью пул-реквестов.

## Воркфлоу

- **`.gitea/workflows/ci.yml`** — на push и PR: `javac` + smoke-run
  (JDK 21 Liberica; Temurin/Zulu недоступны из этой сети).
- **`.gitea/workflows/review.yml`** — на PR и вручную (Run workflow).
  Запускает `.gitea/scripts/review.mjs`: дифф чистится от шума, режется на
  чанки, уходит LLM с требованием JSON-ответа (вердикт + находки с
  файлом/строкой/severity). Результат:
  - один **обновляемый комментарий-сводка** (группировка по файлам,
    кликабельные строки);
  - **инлайн-замечания** на строки диффа;
  - **commit status** `ai-code-review` — красный при блокерах
    (порог настраивается, см. `REVIEW_FAIL_ON`).

## Настройка ревью

1. Бесплатный ключ: https://openrouter.ai/keys
2. Secret: Settings → Actions → Secrets → `OPENROUTER_API_KEY`
   (при своём `REVIEW_BASE_URL` не нужен — ставьте заглушку `dummy`).
3. Variables (опционально): Settings → Actions → Variables:

| Variable | Что делает |
|---|---|
| `REVIEW_MODEL` | цепочка моделей через запятую (дефолт зашит в `review.mjs`) |
| `REVIEW_BASE_URL` | другой OpenAI-совместимый эндпоинт (Ollama/vLLM) |
| `REVIEW_INLINE` | `false` — только сводка, без инлайнов |
| `REVIEW_FAIL_ON` | порог красного статуса: `blocker` (дефолт) / `major` / `never` |
| `REVIEW_PUBLIC_URL` | публичный origin для абсолютных ссылок статуса |

Без ключа воркфлоу не падает — постит в PR комментарий с инструкцией.
`[skip-ai-review]` в заголовке PR отключает ревью для этого PR.
