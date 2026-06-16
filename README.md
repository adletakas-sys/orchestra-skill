# Orchestra — Opus дирижирует и ревьюит, MiMoCode строит

Универсальный оркестратор для постройки **любого** кода/приложения (не только Android). Разделяет роли так, чтобы дорогой и аккуратный Opus думал, а дешёвый/бесплатный исполнитель писал объём.

| Роль | Кто | Что делает |
|------|-----|-----------|
| **Дизайнер + Ревьюер** | Claude **Opus** (`claude -p`) | Декомпозирует задачу в UI-aware спец (PLAN), жёстко ревьюит diff против acceptance-критериев и дизайн-системы (REVIEW). **Read-only.** Пишет код **только** в режиме консилиума как арбитр. |
| **Основной строитель** | **MiMoCode** (`mimo run`) | Пишет/правит код по спеку и фидбэку. Дефолтный исполнитель. |
| **Альтернативный строитель / 2-й ревьюер** | **Gemini** (`gemini -p`) | По запросу: `--executor gemini` (нужен API-ключ) или второе мнение в ревью (`--dual-review`). |

Цикл: **DESIGN-SCAN → [C3 тесты] → PLAN(Opus) → { EXECUTE|CONSILIUM → diff → GATE → RENDER → VERIFY → REVIEW(Opus) → C2 → D2 → C4 аудиты → B4 копирайт → context }\*** пока ревью не одобрит или не кончатся итерации.

Opus запускается строго **read-only** (`--permission-mode plan`, инструменты `Read/Grep/Glob`) — физически не редактирует файлы. Исключение — консилиум (см. ниже), и только при `roles.orchestrator.canWrite:true`.

---

## Установка на новой машине — автоматическая

Ничего ставить руками не нужно. `run.ps1` сам поднимает окружение через `preflight.ps1`:

- находит `node`, `git`, `claude`, `mimo` (а `gemini` — по запросу);
- чего нет из `claude`/`mimo` — ставит `npm install -g @anthropic-ai/claude-code @mimo-ai/cli` (с уведомлением);
- **само-чинит `config.json`**: переписывает `nodeBin` и `bins.{claude,mimo,gemini,git}` реально найденными путями (решает проблему «зашитый путь устарел после обновления»);
- печатает статус авторизации.

```powershell
# из папки целевого репозитория:
C:\yourstart\orchestrator\run.ps1 "Добавь эндпоинт /health -> {status:'ok'}"

# на другом репозитории, с проверкой сборки и лимитом итераций:
C:\yourstart\orchestrator\run.ps1 --dir ..\some-repo --max-iters 5 --verify "npm test" "..."

# только показать план-промпт, ничего не вызывая:
C:\yourstart\orchestrator\run.ps1 --dry-run "..."
```

> ⚠️ Флаги PowerShell (`-WithGemini`, `-SkipSetup`, `-Update`) идут **до** passthrough-аргументов. Всё, что `run.ps1` не распознал, уходит в `orchestrate.mjs` как есть.

### Авторизация
| CLI | Как |
|-----|-----|
| **claude** (Opus) | креды текущей сессии Claude. Если 401 — запусти `claude` раз интерактивно. |
| **mimo** | если 401 — `mimo providers login -p mimo` (MiMo Auto: бесплатно, анонимно). |
| **gemini** | `GEMINI_API_KEY=...` в gitignored `.env.local` (см. `.env.local.example`). Только для `--executor gemini` / `--dual-review`. |

---

## Флаги

| Флаг | Назначение |
|------|-----------|
| позиционный текст / `--task "..."` / `--task-file <path>` | задача |
| `--dir <path>` | целевой git-репозиторий (по умолч. — текущая папка) |
| `--max-iters N` | максимум циклов execute→review (по умолч. 4) |
| `--verify "<cmd>"` | команда сборки/тестов; её вывод уходит ревьюеру (иначе авто-детект по стеку) |
| `--executor mimo\|gemini` | кто пишет код (по умолч. `mimo`) |
| `--model <prov/model>` | переопределить модель исполнителя |
| `--no-review` | один прогон исполнителя без ревью |
| `--dry-run` | только показать план-промпт |
| `--tdd` | **C3**: Opus сперва проектирует acceptance-тесты |
| `--dual-review` | **C2**: Gemini — второй ревьюер, Opus арбитрует вердикты |
| `--render` | **A**: рендер скриншотов и визуальное ревью (если в проекте есть инфра) |
| `--ref-dir <path>` | **D2**: эталонные изображения для сравнения «как на макете» |
| `--audit` | **C4**: финальные аудиты a11y / perf / security / i18n |
| `--ux-copy` | **B4**: Opus как UX-writer (тексты интерфейса) |
| `--consilium` | **E**: тяжёлые шаги строят mimo+gemini+opus, Opus-арбитр выбирает/синтезирует (требует `canWrite:true`) |

Любую необязательную фазу можно включить и через `config.json → phases`.

---

## Привязка к дизайн-системе (переменные)

Оркестр **на старте детектит стек и собирает дизайн-систему проекта** (`design-tokens.json`), затем планирует и ревьюит строго против неё (флажит хардкод цветов/`dp` мимо токенов). Какие файлы считаются «дизайн-системой» — задаётся в `config.json → designSystem.stacks.<stack>.globs`. Таблица по умолчанию:

| Стек (детект по маркерам) | Файлы дизайн-системы (globs) |
|------|------|
| `android-compose` | `**/ui/theme/Color*.kt`, `Type*.kt`, `Typography.kt`, `Spacing*.kt`, `Dimens*.kt`, `Shape*.kt`, `Shapes.kt`, `Elevation*.kt`, `Motion*.kt`, `Theme.kt`, `**/res/values/{colors,dimens,themes,styles}.xml` |
| `ios-swiftui` | `**/*.xcassets/**/Contents.json`, `Theme.swift`, `Color*.swift`, `DesignSystem*.swift`, `Typography.swift`, `Font*.swift`, `Spacing*.swift`, `Tokens.swift` |
| `flutter` | `**/theme.dart`, `app_theme.dart`, `colors.dart`, `typography.dart`, `text_styles.dart`, `spacing.dart`, `tokens.dart` |
| `web-react` | `tailwind.config.*`, `**/theme.{ts,js,tsx,jsx}`, `**/tokens.*`, `**/styles/{globals,tokens,variables,theme}.{css,scss}`, `**/*.module.css` |
| `web-vue` / `web-svelte` / `web-angular` | `tailwind.config.*`, `app.css`/`styles.scss`/`_variables.scss`, `**/theme.*`, `**/tokens.*` |
| `web-vanilla` | `**/{styles,style,main,index,tokens,variables,theme}.css`, `**/index.html` |
| `react-native` | `**/theme.*`, `**/styles/theme.*`, `**/tokens.*`, `**/colors.*` |
| `node-backend` / `python` / `rust` / `go` | `**/design-tokens.json`, `**/tokens.*`, `**/static/**/*.css`, `_variables.scss` |
| `generic` (фолбэк) | `**/design-tokens.json`, `**/tokens.*`, `**/_variables.scss`, `**/{theme,variables,tokens}.{css,scss}` |

Плюс **универсальные носители токенов** ищутся во всех стеках: `**/design-tokens.json`, `**/tokens.json`, `**/*.tokens.json`, `style-dictionary*`.

**Переменные окружения для переопределения** (если автодетект промахнулся):
| Переменная | Что задаёт |
|------------|-----------|
| `ORCHESTRA_STACK` | принудительный стек (напр. `android-compose`) |
| `ORCHESTRA_DESIGN_GLOBS` | свой список globs дизайн-файлов (через запятую) |
| `ORCHESTRA_VERIFY_CMD` | команда сборки/проверки |

Игнорируемые папки при скане: `node_modules, .git, build, .gradle, dist, out, .next, .idea, .dart_tool, Pods, DerivedData, target, vendor, .venv, __pycache__, runs` (`designSystem.ignoreDirs`). Если дизайн-системы нет (greenfield) — Opus предлагает минимальный набор токенов.

---

## Визуальное ревью (A) и reference-driven (D2)

`--render` рендерит экраны и отдаёт PNG ревьюеру (Opus открывает их **Read-инструментом** — он мультимодальный). Движок по стеку: Android → Roborazzi/Paparazzi (JVM, без эмулятора), web → Playwright/Storybook. Если screenshot-инфры в проекте нет — фаза **грациозно отключается** (текстовое ревью + предупреждение), ничего в проект не ставит и не меняет. `--ref-dir` добавляет эталонные картинки: Opus сравнивает рендер с макетом и выдаёт `% соответствия` + список отклонений.

---

## Контекст между моделями (G) и лог токенов (F)

- **Контекст-файл** `context/<projectSlug>.md` (внутри скилла) — общий «мозг» между изолированными процессами агентов: стек, дизайн-система, конвенции, ADR-решения, история итераций, handoff-заметки. Инжектится в промпт каждого агента → контекст не теряется между Opus/MiMo/Gemini и между прогонами.
- **Лог токенов** в каждом прогоне: `usage.json` (по каждому вызову: in/out/cache токены + стоимость) и `usage.md` (сводка + оценка экономии vs «всё на Opus», честно с учётом потери кросс-процессного кэша). Объёмный codegen на бесплатном MiMo Auto не биллится — дорогие токены тратятся только на дизайн/ревью/арбитраж.

---

## Консилиум (E) — Opus пишет тяжёлый код

Когда планировщик помечает шаг `heavy:true` (или флаг `--consilium`) **и** `roles.orchestrator.canWrite:true`: тяжёлый участок независимо строят **mimo**, **gemini** и **opus**, затем **Opus-арбитр** выбирает лучший кандидат или синтезирует гибрид и материализует его. Это единственное место, где Opus получает запись (`--permission-mode acceptEdits`, scoped `--add-dir`). По умолчанию `canWrite:false` → консилиум выключен, Opus остаётся read-only. Перед операцией — жёсткая проверка чистого рабочего дерева (никогда не трогает незакоммиченную работу).

---

## Артефакты

Каждый прогон → `runs/<timestamp>/`: `design-tokens.json`, `spec.json`, `test-plan.json`, `diff.N.patch`, `cand.{mimo,gemini,opus}.N.patch`, `consilium.N.json`, `render.N.json`, `verify.N.log`, `review.N.json`, `review.N.{gemini,final}.json`, `reference.N.json`, `audit.N.{a11y,perf,security,i18n}.json`, `ux-copy.N.json`, `usage.json`/`usage.md`, `context.snapshot.md`, `run.log`. Exit-коды: `0` approved, `1` not-approved/parse-fail/fatal, `2` нет задачи / не git-репо.

> Базовая линия ревью — `git diff HEAD`. Держи рабочее дерево чистым/закоммиченным, иначе ревью увидит посторонние изменения.

---

## Как устроено (модули)

`orchestrate.mjs` — пайплайн; `lib/agents.mjs` — запуск процессов + вызовы агентов (read-only / write); `lib/detect.mjs` — детект стека + дизайн-файлов; `lib/tokens.mjs` — извлечение токенов; `lib/prompts.mjs` — все промпты + JSON-схемы; `lib/render.mjs` — скриншоты (A/D2); `lib/context.mjs` — контекст-файл (G); `lib/usage.mjs` — лог токенов (F); `preflight.ps1`/`run.ps1` — бутстрап + лаунчер. Полный дизайн — в `_design/00_SYNTHESIS.md`.

**Это не служба и не демон** — обычный скрипт, работает только пока запущен. Остановить прогон — `Ctrl+C`; сделанные правки остаются в рабочем дереве (`git checkout -- .` для отката).
