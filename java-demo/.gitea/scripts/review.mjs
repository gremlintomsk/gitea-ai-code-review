#!/usr/bin/env node
// AI code review for Gitea Actions (v2).
//
// Flow: fetch the PR diff via the Gitea API (workflow's GITHUB_TOKEN) →
// filter noise files → split big diffs into chunks → ask an OpenAI-compatible
// endpoint (OpenRouter by default) for structured JSON findings →
// render a Markdown review into a single updatable PR comment →
// post inline review comments → set a commit status
// (failure if any blocker was found).

const env = process.env;

// Fail fast on misconfiguration instead of dying deep inside fetches.
const missing = ['GITHUB_TOKEN', 'GITHUB_API_URL', 'GITHUB_REPOSITORY', 'PR_NUMBER']
  .filter(name => !env[name]);
if (missing.length) {
  console.error(`review.mjs: missing required env: ${missing.join(', ')}`);
  process.exit(1);
}

// Empty-string env vars (e.g. unset Actions variables render as '') must
// fall back to defaults, so destructuring defaults alone are not enough.
const str = (value, fallback) => (value && value.trim() ? value.trim() : fallback);

const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || '';
// Single source of truth for the model fallback chain lives HERE.
// Override per repo via Actions variable REVIEW_MODEL (comma-separated).
const DEFAULT_MODELS = 'nvidia/nemotron-3-super-120b-a12b:free,openai/gpt-oss-20b:free,google/gemma-4-31b-it:free,z-ai/glm-5.2:free';
const MODEL = str(env.MODEL, DEFAULT_MODELS);
// Any OpenAI-compatible endpoint: OpenRouter, Ollama, vLLM, ...
// Override via Actions variable REVIEW_BASE_URL.
const BASE_URL = str(env.BASE_URL, 'https://openrouter.ai/api/v1');
const {
  GITHUB_TOKEN,
  GITHUB_API_URL,
  GITHUB_REPOSITORY,
  PR_NUMBER,
} = env;
const ANSWER_LANG = str(env.ANSWER_LANG, 'Russian');
const REVIEW_INLINE = str(env.REVIEW_INLINE, 'true');
// Commit status threshold: 'blocker' (default) → failure on any blocker,
// 'major' → failure on blockers+majors, 'never' → always success.
// Override via Actions variable REVIEW_FAIL_ON.
const FAIL_ON = str(env.FAIL_ON, 'blocker').toLowerCase();

// Numeric knobs (env values are strings).
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MAX_DIFF_CHARS = num(env.MAX_DIFF_CHARS, 60_000); // per-chunk budget
const LLM_TIMEOUT_MS = num(env.LLM_TIMEOUT_MS, 180_000);
const API_TIMEOUT_MS = num(env.API_TIMEOUT_MS, 30_000);
const MAX_FINDINGS = num(env.MAX_FINDINGS, 30);
const MAX_INLINE = num(env.MAX_INLINE, 20);

const COMMENT_MARKER = '🤖 **AI Code Review**'; // prefix of our summary PR comment
const REVIEW_MARKER = '🤖 AI Code Review'; // prefix of our inline review bodies
const STATUS_CONTEXT = 'ai-code-review';

// ---------------------------------------------------------------- Gitea API

async function gitea(path, options = {}) {
  const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
    ...options,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`Gitea API ${path}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

const giteaJson = async path => (await gitea(path)).json();

const postComment = body => gitea(`/issues/${PR_NUMBER}/comments`, {
  method: 'POST',
  body: JSON.stringify({ body }),
});

// Visible in the commits tab / branch protection: failure = there are blockers.
// Commit statuses need an absolute URL; when Gitea is reached via an internal
// host from CI (http://gitea:3000), REVIEW_PUBLIC_URL overrides the origin.
async function setStatus(state, description) {
  if (!headSha) return;
  const publicOrigin = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const targetUrl = publicOrigin ? `${publicOrigin}${repoPath}/pulls/${PR_NUMBER}` : pr.html_url;
  try {
    await gitea(`/statuses/${headSha}`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        context: STATUS_CONTEXT,
        description: String(description).slice(0, 140),
        target_url: targetUrl,
      }),
    });
  } catch (error) {
    console.log(`commit status failed (non-fatal): ${error.message}`);
  }
}

// Update our previous comment instead of spamming a new one on every push.
async function upsertComment(body) {
  try {
    const comments = await giteaJson(`/issues/${PR_NUMBER}/comments`);
    const mine = comments.filter(c => (c.body || '').startsWith(COMMENT_MARKER)).pop();
    if (mine) {
      await gitea(`/issues/comments/${mine.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      return 'updated';
    }
  } catch (error) {
    console.log(`listing comments failed (${error.message}) — will create a new one`);
  }
  await postComment(body);
  return 'created';
}

// ------------------------------------------------------------ PR & diff

const pr = await giteaJson(`/pulls/${PR_NUMBER}`);
const headSha = pr.head?.sha;
const prTitle = pr.title || '';

// File/line links are RELATIVE to whatever origin the PR is viewed from —
// inside the job the API host is internal (`http://gitea:3000`), which would
// produce dead links in the browser. Falls back to plain code paths when the
// repo URL is not known.
const repoPath = (pr.html_url || '')
  .replace(/^[a-z]+:\/\/[^/]+/, '')
  .replace(/\/pulls\/\d+\/?$/, '');

if (prTitle.toLowerCase().includes('[skip-ai-review]')) {
  console.log('PR title contains [skip-ai-review] — skipping.');
  await upsertComment(`${COMMENT_MARKER} — пропущено: в заголовке PR стоит \`[skip-ai-review]\`.`);
  await setStatus('success', 'skipped: [skip-ai-review]');
  process.exit(0);
}

const diff = await (await gitea(`/pulls/${PR_NUMBER}.diff`)).text();

if (!OPENROUTER_API_KEY) {
  await upsertComment(
    `${COMMENT_MARKER} — пропущено: секрет \`OPENROUTER_API_KEY\` не настроен.\n\n` +
    'Получите бесплатный ключ на https://openrouter.ai/keys и добавьте его в ' +
    'Settings → Actions → Secrets этого репозитория как `OPENROUTER_API_KEY`, ' +
    'затем запустите воркфлоу повторно.',
  );
  console.log('OPENROUTER_API_KEY is not set — posted a notice comment and exited.');
  process.exit(0);
}

// ------------------------------------------------------- diff parsing

// Lockfiles, minified and generated files add noise and eat the context budget.
const NOISE_PATTERNS = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum|go\.work\.sum)$/,
  /\.(min\.(js|css)|\.map)$/,
  /(^|\/)(node_modules|vendor|dist|build|third_party|generated)\//,
  /(\.pb\.go|\.pb\.cc|\.pb\.h|_pb2\.py)$/,
];

const isNoise = path => NOISE_PATTERNS.some(re => re.test(path));

// Split a unified diff into per-file sections and collect the line numbers
// of changed (+) lines in the NEW file, so LLM-provided line numbers can be
// validated before posting inline comments.
function parseFiles(diffText) {
  return diffText
    .split(/^(?=diff --git )/m)
    .map(section => section.replace(/\n$/, ''))
    .filter(section => section.length > 0)
    .map(section => {
      const meta = section.match(/^diff --git a\/(.*) b\/(.*)$/m);
      const plusHeader = section.match(/^\+\+\+ b\/(.+)$/m);
      const path = (plusHeader && plusHeader[1] !== '/dev/null'
        ? plusHeader[1]
        : meta ? meta[2] : '(unknown)'
      ).trim();
      const plus = new Set();
      let newLine = null;
      for (const line of section.split('\n')) {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
          newLine = Number(hunk[1]);
          continue;
        }
        if (newLine === null) continue; // file headers before the first hunk
        if (line.startsWith('+++')) continue;
        if (line.startsWith('-')) continue; // old-side line: new counter stays
        if (line.startsWith('+')) {
          plus.add(newLine); // changed (+) line in the new file
          newLine++;
          continue;
        }
        newLine++; // context line
      }
      return { path, text: section, plus };
    });
}

const allFiles = parseFiles(diff);
const files = allFiles.filter(f => !isNoise(f.path));
const skippedFiles = allFiles.filter(f => isNoise(f.path)).map(f => f.path);

if (files.length === 0) {
  await upsertComment(`${COMMENT_MARKER} — ревьюить нечего: все файлы в диффе — шум (lock-файлы/генерированный код).`);
  await setStatus('success', 'nothing to review');
  console.log('All diff files matched the noise filter — nothing to review.');
  process.exit(0);
}

// Pack files into chunks within the budget; an oversized single file gets
// truncated (with a note) instead of silently dropping the diff tail.
function buildChunks(fileList, budget) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const file of fileList) {
    if (currentLen + file.text.length > budget && current.length) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(file);
    currentLen += file.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const chunks = buildChunks(files, MAX_DIFF_CHARS);
const truncatedFiles = files.filter(f => f.text.length > MAX_DIFF_CHARS).map(f => f.path);

// ------------------------------------------------------- LLM plumbing

const EXT_LANGUAGES = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', java: 'Java', py: 'Python', go: 'Go',
  rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift', scala: 'Scala', sh: 'Shell', bash: 'Shell',
  c: 'C', h: 'C/C++ header', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++',
  yml: 'YAML', yaml: 'YAML', json: 'JSON', xml: 'XML', sql: 'SQL',
  html: 'HTML', css: 'CSS', md: 'Markdown', dockerfile: 'Dockerfile',
};
const detectLanguages = fileList => {
  const langs = new Set();
  for (const { path } of fileList) {
    const ext = path.toLowerCase().split('.').pop();
    if (EXT_LANGUAGES[ext]) langs.add(EXT_LANGUAGES[ext]);
    if (/dockerfile/i.test(path)) langs.add('Dockerfile');
  }
  return [...langs];
};

const systemPrompt = languages =>
  'You are a strict but constructive senior code reviewer. ' +
  `Languages in this change: ${languages.join(', ') || 'unknown'}. ` +
  'Review the unified diff and report only real problems: bugs and unhandled edge cases, ' +
  'security issues, swallowed exceptions, resource leaks, race conditions, O(n^2) patterns, ' +
  'misleading naming, API misuse, missing null/empty-input handling. Ignore style trivia.\n' +
  'Respond with ONLY a JSON object (no markdown fences) in this exact schema:\n' +
  '{\n' +
  '  "verdict": "approve" | "concerns" | "request_changes",\n' +
  '  "summary": "1-2 sentence overall assessment",\n' +
  '  "findings": [\n' +
  '    { "file": "path exactly as in the diff", "line": <line number in the NEW file>, ' +
  '"severity": "blocker" | "major" | "minor", "message": "what is wrong and why it matters", "suggestion": "concrete fix" }\n' +
  '  ]\n' +
  '}\n' +
  'Rules: "line" must refer to a changed (+) line from the diff. If there is nothing to report, ' +
  `return an empty findings array. Write summary, message and suggestion in ${ANSWER_LANG}; ` +
  'keep verdict and severity values in English exactly as specified.';

// The network path to openrouter.ai occasionally drops TLS connections
// (ECONNRESET) and free-tier models return 429/5xx under load — retry both.
async function completion(payload, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        console.log(`${BASE_URL} ${response.status}, retry ${attempt}/${attempts - 1}...`);
      } else {
        return response;
      }
    } catch (error) {
      if (attempt >= attempts) throw error;
      console.log(`LLM network error (${error.cause?.code ?? error.message}), retry ${attempt}/${attempts - 1}...`);
    }
    await new Promise(resolve => setTimeout(resolve, attempt * 10_000));
  }
}

// Models sometimes wrap JSON in fences or add prose around it — extract the
// outermost object and parse tolerantly.
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SEVERITIES = ['blocker', 'major', 'minor'];

function normalizeReview(parsed) {
  const findings = (Array.isArray(parsed.findings) ? parsed.findings : [])
    .map(f => ({
      file: String(f.file || '').trim(),
      line: Number(f.line) > 0 ? Math.floor(Number(f.line)) : 0,
      severity: SEVERITIES.includes(String(f.severity || '').toLowerCase())
        ? String(f.severity).toLowerCase()
        : 'minor',
      message: String(f.message || '').trim(),
      suggestion: String(f.suggestion || '').trim(),
    }))
    .filter(f => f.message);
  const verdict = ['approve', 'concerns', 'request_changes'].includes(parsed.verdict)
    ? parsed.verdict
    : null;
  return { verdict, summary: String(parsed.summary || '').trim(), findings };
}

let totalTokens = 0;

// Walk the model chain until one answers with a parseable review.
// `preferred` (the model that already succeeded on a previous chunk) is tried first.
async function reviewChunk(modelChain, preferred, chunkFiles) {
  const languages = detectLanguages(chunkFiles);
  const diffText = chunkFiles
    .map(f => (f.text.length > MAX_DIFF_CHARS ? f.text.slice(0, MAX_DIFF_CHARS) : f.text))
    .join('\n');
  const messages = [
    { role: 'system', content: systemPrompt(languages) },
    { role: 'user', content: `PR diff:\n\n\`\`\`diff\n${diffText}\n\`\`\`` },
  ];
  const chain = [...modelChain];
  if (preferred && chain[0] !== preferred) {
    chain.splice(chain.indexOf(preferred), 1);
    chain.unshift(preferred);
  }
  const errors = [];
  for (const model of chain) {
    console.log(`Trying model: ${model}`);
    try {
      const response = await completion({ model, messages, temperature: 0.2, max_tokens: 4000 });
      if (!response.ok) {
        errors.push(`${model}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
        continue;
      }
      const data = await response.json();
      if (data.error) {
        const message = typeof data.error === 'string' ? data.error : data.error.message;
        errors.push(`${model}: ${message}`);
        continue;
      }
      const content = data.choices?.[0]?.message?.content;
      const parsed = extractJson(content);
      if (!parsed) {
        errors.push(`${model}: unparsable/empty completion`);
        continue;
      }
      if (data.usage) {
        totalTokens += (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }
      if (data.choices?.[0]?.finish_reason === 'length') {
        console.log(`warning: ${model} hit max_tokens, review may be incomplete`);
      }
      return { model, review: normalizeReview(parsed) };
    } catch (error) {
      errors.push(`${model}: ${error.cause?.code ?? error.message}`);
    }
  }
  return { errors };
}

// ------------------------------------------------------- run the review

const models = MODEL.split(',').map(m => m.trim()).filter(Boolean);
console.log(`Reviewing PR #${PR_NUMBER}: ${files.length} files (${skippedFiles.length} noise skipped), ${chunks.length} chunk(s)`);

let preferredModel;
const chunkResults = [];
const failedFiles = [];
for (const chunk of chunks) {
  const result = await reviewChunk(models, preferredModel, chunk);
  if (result.model) {
    preferredModel = result.model;
    chunkResults.push(result.review);
  } else {
    failedFiles.push(...chunk.map(f => f.path));
    console.log(`chunk failed on all models:\n${result.errors.join('\n')}`);
  }
}

if (chunkResults.length === 0) {
  await upsertComment(
    `${COMMENT_MARKER} — ни одна модель не ответила.\n\n` +
    `Не отревьюено файлов: ${failedFiles.length}. Подробности в логах джобы (модели часто перегружены — можно перезапустить ран).`,
  );
  await setStatus('error', 'AI review failed: no model responded');
  throw new Error('All models failed');
}

// ------------------------------------------------------- aggregate

const byKey = new Map();
for (const result of chunkResults) {
  for (const finding of result.findings) {
    byKey.set(`${finding.file}:${finding.line}:${finding.message.slice(0, 80)}`, finding);
  }
}
let findings = [...byKey.values()]
  .sort((a, b) =>
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    a.file.localeCompare(b.file) || a.line - b.line);
const findingsTruncated = findings.length > MAX_FINDINGS;
if (findingsTruncated) findings = findings.slice(0, MAX_FINDINGS);

const counts = {
  blocker: findings.filter(f => f.severity === 'blocker').length,
  major: findings.filter(f => f.severity === 'major').length,
  minor: findings.filter(f => f.severity === 'minor').length,
};
const verdict =
  counts.blocker > 0 ? 'request_changes' :
  counts.major > 0 ? 'concerns' : 'approve';

const SEVERITY_ICONS = { blocker: '🚨', major: '⚠️', minor: '💬' };
const VERDICTS = {
  request_changes: '🚨 **Требуются правки**',
  concerns: '⚠️ **Есть замечания**',
  approve: '✅ **Можно мержить**',
};

const fileUrl = (path, line) =>
  pr.html_url
    ? `src/branch/${pr.head?.ref || 'main'}` +
      `/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`
    : null;
const linkFile = path => {
  const url = fileUrl(path);
  return url ? `[\`${path}\`](${url})` : `\`${path}\``;
};
const linkLine = (path, line) => {
  const url = fileUrl(path, line);
  return url ? `[L${line}](${url})` : `\`${path}:${line}\``;
};

const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};
const fmtTokens = n => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);

const shortList = (list, limit = 5) => {
  const head = list.slice(0, limit).map(f => `\`${f}\``).join(', ');
  return list.length > limit ? `${head} и ещё ${list.length - limit}` : head;
};

const notes = [];
if (skippedFiles.length) notes.push(`🔇 Пропущены (шум/генерированное): ${shortList(skippedFiles)}`);
if (truncatedFiles.length) notes.push(`✂️ Обрезаны до ${MAX_DIFF_CHARS} символов: ${shortList(truncatedFiles)}`);
if (failedFiles.length) notes.push(`⚠️ Не отревьюено (модели не ответили): ${shortList(failedFiles)}`);
if (findingsTruncated) notes.push(`✂️ Показаны первые ${MAX_FINDINGS} замечаний (всего ${byKey.size}).`);

const summary = chunkResults.map(r => r.summary).filter(Boolean).join('\n\n') || '(модель не дала сводку)';

// Snap LLM line numbers to real changed (+) lines once, reuse for both the
// summary links and the inline comments.
const fileByPath = new Map(files.map(f => [f.path, f]));
for (const finding of findings) {
  const file = fileByPath.get(finding.file);
  finding.anchorLine = finding.line > 0 && file ? snapToPlusLine(file, finding.line) : null;
}

// Group findings by file; entries that can't be anchored to a changed line
// (file outside the diff, no line from the model) go to a loose section.
const byFile = new Map();
const looseFindings = [];
for (const finding of findings) {
  if (finding.anchorLine) {
    if (!byFile.has(finding.file)) byFile.set(finding.file, []);
    byFile.get(finding.file).push(finding);
  } else {
    looseFindings.push(finding);
  }
}

const bullet = f =>
  `- ${linkLine(f.file, f.anchorLine)} ${SEVERITY_ICONS[f.severity]} ${f.message}` +
  (f.suggestion ? ` → ${f.suggestion}` : '');

let fileSections = '';
for (const [path, fileFindings] of byFile) {
  fileSections += `#### 📄 ${linkFile(path)}\n${fileFindings.map(bullet).join('\n')}\n\n`;
}
if (looseFindings.length) {
  fileSections += '#### 🧷 Без привязки к строке\n' +
    looseFindings
      .map(f =>
        `- ${SEVERITY_ICONS[f.severity]} \`${f.file}${f.line ? ':' + f.line : ''}\` — ${f.message}` +
        (f.suggestion ? ` → ${f.suggestion}` : ''),
      )
      .join('\n') + '\n\n';
}

const findingsLabel = findings.length
  ? ` — ${findings.length} ${plural(findings.length, 'замечание', 'замечания', 'замечаний')}`
  : '';

const commentBody =
  `🤖 **AI Code Review**: ${VERDICTS[verdict]}${findingsLabel} · \`${preferredModel}\` · ${fmtTokens(totalTokens)} токенов\n\n` +
  (notes.length ? notes.map(n => `> ${n}`).join('\n') + '\n\n' : '') +
  `${summary}\n\n` +
  fileSections +
  (findings.length ? '' : '_Замечаний нет._\n\n') +
  '<sub>Обновляется при каждом пуше · `[skip-ai-review]` в заголовке PR отключает ревью</sub>';

await upsertComment(commentBody);
console.log('Review comment posted.');

// ------------------------------------------------------- inline comments

// Remove our previous inline review(s) so re-runs don't pile up duplicates.
async function deleteOldInlineReviews() {
  try {
    const reviews = await giteaJson(`/pulls/${PR_NUMBER}/reviews`);
    for (const review of reviews) {
      if ((review.body || '').startsWith(REVIEW_MARKER)) {
        await gitea(`/pulls/${PR_NUMBER}/reviews/${review.id}`, { method: 'DELETE' });
      }
    }
  } catch (error) {
    console.log(`deleting old inline reviews failed (non-fatal): ${error.message}`);
  }
}

// Snap an LLM-provided line number to a real changed (+) line of the file
// (models are off by a few lines surprisingly often).
function snapToPlusLine(file, line) {
  if (file.plus.has(line)) return line;
  let best = null;
  let bestDist = 6; // don't snap further than 5 lines away
  for (const plus of file.plus) {
    const dist = Math.abs(plus - line);
    if (dist < bestDist) {
      best = plus;
      bestDist = dist;
    }
  }
  return best;
}

if (REVIEW_INLINE !== 'false' && findings.length) {
  await deleteOldInlineReviews();
  const inlineComments = [];
  for (const finding of findings) {
    if (inlineComments.length >= MAX_INLINE) break;
    if (!finding.anchorLine) continue;
    const label = `${SEVERITY_ICONS[finding.severity]} **${finding.severity.toUpperCase()}**`;
    inlineComments.push({
      path: finding.file,
      new_position: finding.anchorLine,
      body: `🤖 ${label} — ${finding.message}` + (finding.suggestion ? `\n\n💡 ${finding.suggestion}` : ''),
    });
  }
  if (inlineComments.length) {
    try {
      await gitea(`/pulls/${PR_NUMBER}/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          event: 'COMMENT',
          body: `${REVIEW_MARKER} — инлайн-замечания (${preferredModel}, run ${String(headSha || '').slice(0, 8)})`,
          comments: inlineComments,
        }),
      });
      console.log(`Posted ${inlineComments.length} inline comment(s).`);
    } catch (error) {
      console.log(`posting inline review failed (non-fatal, summary comment stands): ${error.message}`);
    }
  }
}

// ------------------------------------------------------- commit status

const statusDescription =
  verdict === 'request_changes' ? `blockers: ${counts.blocker}, majors: ${counts.major}` :
  verdict === 'concerns' ? `majors: ${counts.major}, minors: ${counts.minor}` :
  'no significant findings';
const passesThreshold =
  FAIL_ON === 'never' ? true :
  FAIL_ON === 'major' ? counts.blocker + counts.major === 0 :
  counts.blocker === 0;
await setStatus(passesThreshold ? 'success' : 'failure', statusDescription);

console.log(`Done: verdict=${verdict}, findings=${findings.length} (${JSON.stringify(counts)}), status=${passesThreshold ? 'success' : 'failure'} (fail_on=${FAIL_ON}).`);
