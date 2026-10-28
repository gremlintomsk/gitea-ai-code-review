# java-demo

Простой Java-проект для демонстрации AI code review в Gitea Actions.

- `.gitea/workflows/ci.yml` — сборка (`javac`) и smoke-run в контейнере с JDK 21
  (Liberica; Temurin/Zulu недоступны из этой сети).
- `.gitea/workflows/review.yml` — на каждый PR (и вручную через
  **Run workflow**) запускает `.gitea/scripts/review.mjs`: дифф чистится от
  шума, режется на чанки и отправляется LLM с требованием структурированного
  JSON-ответа. Результат — один обновляемый комментарий-сводка, инлайн-
  замечания на строки диффа и commit status `ai-code-review`
  (failure при блокерах — можно включить в branch protection).

## Настройка ревью

1. Бесплатный ключ: https://openrouter.ai/keys
2. Repo → Settings → Actions → Secrets → `OPENROUTER_API_KEY`.
3. Переменные (опционально), Repo → Settings → Actions → Variables:
   - `REVIEW_MODEL` — цепочка моделей через запятую
     (дефолт зашит в `review.mjs`);
   - `REVIEW_BASE_URL` — другой OpenAI-совместимый эндпоинт
     (Ollama/vLLM — тогда ключ не нужен, ставьте заглушку);
   - `REVIEW_INLINE=false` — только сводка, без инлайн-комментариев;
   - `REVIEW_FAIL_ON` — когда статус красный: `blocker` (дефолт), `major`,
     `never` (всегда зелёный);
   - `REVIEW_PUBLIC_URL` — публичный origin для абсолютных ссылок,
     если CI ходит в Gitea по внутреннему хосту.

Без ключа воркфлоу не падает — постит в PR комментарий с инструкцией.
`[skip-ai-review]` в заголовке PR отключает ревью для этого PR.
