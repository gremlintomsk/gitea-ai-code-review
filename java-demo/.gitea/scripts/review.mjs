// AI code review for Gitea Actions.
// Fetches the PR diff from the Gitea API, sends it to an OpenAI-compatible
// endpoint (OpenRouter by default — walks a chain of free models) and posts the
// review back as a PR comment using the workflow's GITHUB_TOKEN.

const {
  OPENROUTER_API_KEY,
  MODEL = 'nvidia/nemotron-3-super-120b-a12b:free,openai/gpt-oss-20b:free,google/gemma-4-31b-it:free,z-ai/glm-5.2:free',
  GITHUB_TOKEN,
  GITHUB_API_URL,
  GITHUB_REPOSITORY,
  PR_NUMBER,
} = process.env;

const MAX_DIFF_CHARS = 60_000;

async function gitea(path, options = {}) {
  const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
    ...options,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Gitea API ${path}: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function postComment(body) {
  await gitea(`/issues/${PR_NUMBER}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

const diff = await (await gitea(`/pulls/${PR_NUMBER}.diff`)).text();
const truncated = diff.length > MAX_DIFF_CHARS;
const diffForPrompt = truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff;

if (!OPENROUTER_API_KEY) {
  await postComment(
    '🤖 **AI Code Review** — пропущено: секрет `OPENROUTER_API_KEY` не настроен.\n\n' +
    'Получите бесплатный ключ на https://openrouter.ai/keys и добавьте его в ' +
    'Settings → Actions → Secrets этого репозитория как `OPENROUTER_API_KEY`.'
  );
  console.log('OPENROUTER_API_KEY is not set — posted a notice comment and exited.');
  process.exit(0);
}

// The network path to openrouter.ai occasionally drops TLS connections
// (ECONNRESET) and free-tier models return 429/5xx under load — retry both.
async function completionWithRetries(payload, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        console.log(`OpenRouter ${response.status}, retry ${attempt}/${attempts - 1}...`);
      } else {
        return response;
      }
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.log(`OpenRouter network error (${error.cause?.code ?? error.message}), retry ${attempt}/${attempts - 1}...`);
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 10_000));
  }
}

// MODEL is a comma-separated fallback chain: free-tier models come and go
// (deepseek :free was retired) and get rate-limited upstream, so we walk the
// list until one answers.
const models = MODEL.split(',').map(m => m.trim()).filter(Boolean);
const messages = [
  {
    role: 'system',
    content:
      'You are a strict but constructive senior Java code reviewer. ' +
      'Review the following unified diff. Report only real problems: bugs, ' +
      'reference-equality string comparison, swallowed exceptions, resource ' +
      'leaks, O(n^2) patterns, naming and API misuse. For each finding give ' +
      'file, line context, severity (blocker/major/minor) and a concrete fix. ' +
      'Finish with a short verdict. Answer in Russian, GitHub Markdown.',
  },
  { role: 'user', content: 'PR diff:\n\n```diff\n' + diffForPrompt + '\n```' },
];

let review;
let usedModel;
const errors = [];
for (const model of models) {
  console.log(`Trying model: ${model}`);
  const completion = await completionWithRetries({ model, messages, temperature: 0.2 }, 3);
  if (!completion.ok) {
    errors.push(`${model}: ${completion.status} ${(await completion.text()).slice(0, 300)}`);
    continue;
  }
  const data = await completion.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    errors.push(`${model}: empty completion`);
    continue;
  }
  review = content;
  usedModel = model;
  break;
}

if (!review) {
  const details = errors.join('\n');
  await postComment(`🤖 **AI Code Review** — ни одна модель не ответила:\n\n\`\`\`\n${details.slice(0, 1500)}\n\`\`\``);
  throw new Error('All models failed:\n' + details);
}

await postComment(
  `🤖 **AI Code Review** (модель: \`${usedModel}\`)` +
  (truncated ? '\n\n> ⚠️ Дифф обрезан до 60k символов.' : '') +
  '\n\n' + review
);
console.log('Review posted.');
