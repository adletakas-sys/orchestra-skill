# Orchestra v2.1 — Opus дирижирует и ревьюит, MiMoCode строит

Универсальный многоагентный оркестратор для постройки **любого** кода/приложения. Разделяет роли так, чтобы дорогой и аккуратный Opus думал, а дешёвый/бесплатный исполнитель писал объём.

| Роль | Кто | Что делает |
|------|-----|-----------|
| **Планировщик** | Claude Opus (`--planner-model` для override) | Декомпозирует задачу в UI-aware спек (PLAN). Можно заменить на Sonnet командой `--planner-model sonnet` — дешевле, качество декомпозиции аналогичное. |
| **Ревьюер** | Claude Opus (с опциональным Sonnet первым проходом) | Строго ревьюит diff против acceptance-критериев и дизайн-системы. При `--escalate-reviewer` Sonnet делает первый проход; Opus вызывается только если score < порога или есть blocking-проблемы. **Read-only.** |
| **Основной строитель** | **MiMoCode** (`mimo run`) | Пишет/правит код по спеку и фидбэку. Дефолтный исполнитель. |
| **Альтернативный строитель / 2-й ревьюер** | **Gemini** (`gemini -p`) | `--executor gemini` или второе мнение в ревью (`--dual-review`). |

**Базовый цикл:**

```
DESIGN-SCAN → [C3 тесты] → PLAN(Opus/Sonnet)
  → { EXECUTE | LITE-CONSILIUM | CONSILIUM
      → diff → GATE → RENDER → VERIFY
      → REVIEW(эскалирующий) → C2 → D2 → C4 аудиты → B4 копирайт
      → context } × N итераций
→ RESULT (cost summary)
```

Opus работает строго **read-only** (`--permission-mode plan`) — физически не редактирует файлы. Исключение — полный консилиум (`--consilium` + `canWrite:true`).

---

## Установка

Ничего ставить руками не нужно. `run.ps1` сам поднимает окружение через `preflight.ps1`:

- находит `node`, `git`, `claude`, `mimo` (а `gemini` — по запросу);
- чего нет из `claude`/`mimo` — ставит `npm install -g @anthropic-ai/claude-code @mimo-ai/cli`;
- **само-чинит `config.json`**: переписывает `nodeBin` и `bins.*` реально найденными путями;
- печатает статус авторизации.

```powershell
# из папки целевого репозитория:
C:\path\to\orchestra\run.ps1 "Добавь эндпоинт /health -> {status:'ok'}"

# другой репозиторий, с тестами и ограничением итераций:
C:\path\to\orchestra\run.ps1 --dir ..\some-repo --max-iters 5 --verify "npm test" "..."

# только показать план-промпт, ничего не вызывать:
C:\path\to\orchestra\run.ps1 --dry-run "..."
```

> Флаги PowerShell (`-WithGemini`, `-SkipSetup`, `-Update`) идут **до** остальных аргументов. Всё что `run.ps1` не распознал уходит в `orchestrate.mjs` как есть.

### Авторизация

| CLI | Как |
|-----|-----|
| **claude** (Opus/Sonnet) | креды текущей сессии Claude. Если 401 — запусти `claude` раз интерактивно. |
| **mimo** | если 401 — `mimo providers login -p mimo` (MiMo Auto: бесплатно, анонимно). |
| **gemini** | `GEMINI_API_KEY=...` в `.env.local` (см. `.env.local.example`). Только для `--executor gemini` / `--dual-review`. |

---

## Флаги

### Основные

| Флаг | Назначение |
|------|-----------|
| позиционный текст / `--task "..."` / `--task-file <path>` | задача |
| `--dir <path>` | целевой git-репозиторий (по умолч. — текущая папка) |
| `--max-iters N` | максимум циклов execute→review (по умолч. 4) |
| `--verify "<cmd>"` | команда сборки/тестов; вывод уходит ревьюеру (иначе авто-детект по стеку) |
| `--executor mimo\|gemini` | кто пишет код (по умолч. `mimo`) |
| `--model <prov/model>` | переопределить модель исполнителя |
| `--no-review` | один прогон исполнителя без ревью |
| `--dry-run` | только показать план-промпт |

### Управление стоимостью (новое в v2.1)

| Флаг | Назначение |
|------|-----------|
| `--planner-model sonnet` | Sonnet как планировщик (дешевле ~50%); Opus по-прежнему ревьюит. Конфигурируется в `config.json → roles.planner.model`. |
| `--escalate-reviewer` | Sonnet делает первый ревью-проход; Opus вызывается только если score < порога (default 70) или есть blocking-проблемы. Порог и модель — `config.json → roles.reviewer.escalateThreshold/escalateModel`. |
| `--budget <usd>` | Жёсткий лимит расходов в USD на прогон. При 90% потраченного отключаются опциональные фазы; при достижении потолка прогон останавливается. Переопределяет `config.json → budget.maxUsd`. |

### Дополнительные кандидаты (новое в v2.1)

| Флаг | Назначение |
|------|-----------|
| `--lite-consilium` | Тяжёлые шаги строят mimo+gemini последовательно, Opus (read-only) выбирает победителя и применяет через `git apply`. Не требует `canWrite:true`. |
| `--parallel-exec` | Два кандидата (mimo+gemini) на **каждой** итерации, Opus-арбитр выбирает лучший. |
| `--lock-mimo` | File-based мьютекс (`mimo.lock`) — предотвращает CPU-конкуренцию при параллельных прогонах Orchestra на одной машине. |

### Управление прогоном (новое в v2.1)

| Флаг | Назначение |
|------|-----------|
| `--resume <run-dir>` | Возобновить прерванный прогон: загружает `spec.json` + последний `review.N.json` из указанной папки, пропускает DESIGN-SCAN и PLAN, продолжает со следующей итерации. |

### Фазы (опциональные)

| Флаг | Назначение |
|------|-----------|
| `--tdd` | **C3**: Opus сперва проектирует acceptance-тесты |
| `--dual-review` | **C2**: Gemini — второй ревьюер, Opus арбитрует вердикты |
| `--render` | **A**: рендер скриншотов и визуальное ревью |
| `--ref-dir <path>` | **D2**: эталонные изображения для сравнения с рендером |
| `--audit` | **C4**: финальные аудиты a11y / perf / security / i18n |
| `--ux-copy` | **B4**: Opus как UX-writer (тексты интерфейса) |
| `--consilium` | **E**: тяжёлые шаги строят mimo+gemini+opus, Opus-арбитр выбирает/синтезирует (требует `roles.orchestrator.canWrite:true`) |

Любую опциональную фазу можно включить и через `config.json → phases`.

---

## Экономика (бенчмарки)

| Задача | Конфигурация | Стоимость | Итог |
|--------|-------------|----------|------|
| REST API ~850 строк | pure Opus | $1.16 | ok |
| REST API ~850 строк | Orchestra (Opus+mimo) | **$0.81** (−30%) | ok |
| Job-queue ~2500 строк | pure Opus | $7.31 | ok |
| Job-queue ~2500 строк | Orchestra off | **$1.96** (−73%) | APPROVED ✅ |

**Принцип экономии:** объёмный codegen делает бесплатный mimo, Opus тратит токены только на PLAN + REVIEW (3–4 коротких вызова). При `--planner-model sonnet` и `--escalate-reviewer` расход на Opus снижается ещё на 30–50%.

> Параллельный запуск нескольких Orchestra на одной машине кладёт mimo по таймауту из-за CPU-конкуренции. Используй `--lock-mimo` или запускай последовательно.

---

## Адаптивный выход (новое в v2.1)

- **Early-exit** (`earlyExitScore`, default 95): если ревью даёт score ≥ 95 и нет blocking-проблем — автоматически одобряется без ожидания следующей итерации.
- **Early-abort** (`abortScore`, default 20): если score < 20 и executor не произвёл никакого diff — прогон останавливается досрочно (исполнитель не сходится). Оба порога задаются в `config.json → execution`.

---

## Executor trap memory (новое в v2.1)

При каждом отклонённом ревью blocking-проблемы, нарушения дизайн-системы и a11y-находки записываются в секцию `executorTraps` контекст-файла (SCHEMA_VERSION 2). Следующий retry получает этот список как «known failure patterns» — executor видит свои прошлые ошибки и делает хирургические правки, а не переписывает код с нуля.

---

## Prompt-cache warming (новое в v2.1)

`plannerPrompt` и `reviewerPrompt` начинаются с **идентичного** `sharedCachePrefix(task, tokens)`. Поскольку задача и токены одинаковы внутри одного прогона, байты префикса совпадают — это максимизирует вероятность попадания в 5-минутный ephemeral-кэш Claude между вызовами PLAN и REVIEW.

---

## Привязка к дизайн-системе

Оркестр на старте **детектирует стек и собирает дизайн-систему** (`design-tokens.json`), планирует и ревьюит строго против неё (флажит хардкод цветов/dp мимо токенов).

| Стек | Файлы дизайн-системы (globs) |
|------|------|
| `android-compose` | `**/ui/theme/Color*.kt`, `Type*.kt`, `Spacing*.kt`, `Dimens*.kt`, `Shape*.kt`, `Elevation*.kt`, `Motion*.kt`, `Theme.kt`, `**/res/values/{colors,dimens,themes,styles}.xml` |
| `ios-swiftui` | `**/*.xcassets/**/Contents.json`, `Theme.swift`, `Color*.swift`, `DesignSystem*.swift`, `Typography.swift`, `Spacing*.swift`, `Tokens.swift` |
| `flutter` | `**/theme.dart`, `app_theme.dart`, `colors.dart`, `typography.dart`, `spacing.dart`, `tokens.dart` |
| `web-react` | `tailwind.config.*`, `**/theme.{ts,js,tsx,jsx}`, `**/tokens.*`, `**/styles/{globals,tokens,variables,theme}.{css,scss}`, `**/*.module.css` |
| `web-vue` / `web-svelte` / `web-angular` | `tailwind.config.*`, `app.css` / `_variables.scss`, `**/theme.*`, `**/tokens.*` |
| `web-vanilla` | `**/{styles,style,main,index,tokens,variables,theme}.css`, `**/index.html` |
| `react-native` | `**/theme.*`, `**/styles/theme.*`, `**/tokens.*`, `**/colors.*` |
| `node-backend` / `python` / `rust` / `go` | `**/design-tokens.json`, `**/tokens.*`, `**/static/**/*.css` |
| `generic` (фолбэк) | `**/design-tokens.json`, `**/tokens.*`, `**/_variables.scss` |

**Переменные окружения для переопределения:**

| Переменная | Что задаёт |
|------------|-----------|
| `ORCHESTRA_STACK` | принудительный стек (напр. `android-compose`) |
| `ORCHESTRA_DESIGN_GLOBS` | свой список globs через запятую |
| `ORCHESTRA_VERIFY_CMD` | команда сборки/проверки |

---

## Визуальное ревью (`--render`, `--ref-dir`)

`--render` рендерит экраны и отдаёт PNG ревьюеру. Движок по стеку: Android → Roborazzi/Paparazzi (без эмулятора), web → Playwright/Storybook. Если screenshot-инфры нет — фаза **грациозно отключается**, ничего в проект не ставит. `--ref-dir` добавляет эталонные картинки: Opus сравнивает рендер с макетом и выдаёт процент соответствия + список отклонений.

---

## Консилиум (`--consilium` и `--lite-consilium`)

| Режим | Требование | Как работает |
|-------|-----------|-------------|
| `--consilium` | `roles.orchestrator.canWrite:true` | mimo+gemini+opus независимо строят тяжёлый участок; Opus-арбитр выбирает/синтезирует и **материализует** результат (единственный write Opus). |
| `--lite-consilium` | нет (Opus read-only) | mimo+gemini строят последовательно; Opus-арбитр выбирает победителя; результат применяется через `git apply`. |

Перед операцией — жёсткая проверка чистого рабочего дерева.

---

## Контекст и логи

- **Контекст-файл** `context/<projectSlug>.md` — общий «мозг» между агентами: стек, дизайн-система, ADR-решения, история итераций, executor-трапы. Инжектируется в промпт каждого агента.
- **Лог токенов**: `usage.json` (по каждому вызову: in/out/cache + стоимость) и `usage.md` (сводка + оценка экономии vs «всё на Opus»).
- **Cost summary** в stdout: в конце каждого прогона — `cost: $X.XX (baseline $Y.YY, savings ~Z%)`.

---

## Артефакты прогона

Каждый прогон → `runs/<timestamp>/`:

```
design-tokens.json      spec.json               test-plan.json
diff.N.patch            exec.N.log              verify.N.log
review.N.json           review.N.gemini.json    review.N.final.json
cand.{mimo,gemini,opus}.N.patch                 consilium.N.json
dual-arbiter.N.json     reference.N.json
audit.N.{a11y,perf,security,i18n}.json          ux-copy.N.json
usage.json              usage.md                context.snapshot.md
run.log
```

Exit-коды: `0` approved, `1` not-approved/parse-fail/fatal, `2` нет задачи / не git-репо.

> Базовая линия ревью — `git diff HEAD`. Держи рабочее дерево чистым/закоммиченным, иначе ревью увидит посторонние изменения.

---

## Модули

| Файл | Назначение |
|------|-----------|
| `orchestrate.mjs` | пайплайн, флаги, все фазы |
| `lib/agents.mjs` | запуск процессов + вызовы агентов (read-only / write) |
| `lib/detect.mjs` | детект стека + дизайн-файлов |
| `lib/tokens.mjs` | извлечение токенов |
| `lib/prompts.mjs` | все промпты + JSON-схемы, sharedCachePrefix |
| `lib/render.mjs` | скриншоты (A/D2) |
| `lib/context.mjs` | контекст-файл, executorTraps, SCHEMA_VERSION 2 |
| `lib/usage.mjs` | лог токенов, cost summary |
| `preflight.ps1` | само-починка config.json, установка CLI |
| `run.ps1` | PowerShell-лаунчер |
| `config.json` | конфигурация ролей, фаз, лимитов, стоимости |
| `CHANGELOG.md` | история версий |

Полный дизайн — в `DESIGN.md`.

**Это не служба** — обычный скрипт. `Ctrl+C` останавливает прогон; сделанные правки остаются в рабочем дереве (`git checkout -- .` для отката). Прерванный прогон можно возобновить через `--resume runs/<timestamp>`.
