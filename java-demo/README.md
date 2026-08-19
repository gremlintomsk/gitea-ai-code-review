# java-demo

Простой Java-проект для демонстрации AI code review в Gitea Actions.

- `.gitea/workflows/ci.yml` — сборка (`javac`) и smoke-run в контейнере Temurin 21.
- `.gitea/workflows/review.yml` — на каждый PR запрашивает ревью диффа у LLM
  через OpenRouter (по умолчанию бесплатная модель
  `deepseek/deepseek-chat-v3-0324:free`) и постит результат комментарием в PR.

## Настройка ревью

1. Бесплатный ключ: https://openrouter.ai/keys
2. Repo → Settings → Actions → Secrets → `OPENROUTER_API_KEY`.
3. (Опционально) Repo → Settings → Actions → Variables → `REVIEW_MODEL`,
   чтобы сменить модель (например `deepseek/deepseek-r1:free`).

Без ключа воркфлоу не падает — постит в PR комментарий с инструкцией.
