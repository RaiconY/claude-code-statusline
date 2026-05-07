# Prompt Caching — карта механизма

> Внутренняя справка по Anthropic prompt caching. Собрана из официальной
> документации платформы и эмпирически подтверждена на реальных Claude Code
> transcript-файлах. Используется как опора для фичи `cache` в `statusline.js`.

**Главные источники:**
- <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- <https://platform.claude.com/docs/en/build-with-claude/streaming>
- <https://platform.claude.com/docs/en/api/messages>
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching>

---

## 1. Концепция: префикс + breakpoint (BP)

```
┌───────────────────── REQUEST ──────────────────────┐
│                                                    │
│  tools[]      system[]       messages[]            │
│  ┌─────┐      ┌────────┐     ┌──┬──┬──┬──┬──┬──┐  │
│  │ T1..│ ───▶ │ S1.. Sn│ ──▶ │M1│M2│M3│M4│M5│M6│  │
│  └─────┘      └────────┘     └──┴──┴──┴──┴──┴──┘  │
│       ▲           ▲                ▲      ▲       │
│       │           │                │      │       │
│  cache_control  cache_control  cache_ctl  cache_ctl
│   (BP #1)        (BP #2)       (BP #3)    (BP #4) │
│                                                    │
│  Хеш считается по ВСЕМУ префиксу до и включая BP. │
└────────────────────────────────────────────────────┘
                         ↓
                  ┌────────────┐
                  │ Cache Pool │  (per workspace, per model)
                  │  hash → KV │
                  └────────────┘
```

- **BP** — `breakpoint`, точка с пометкой `{"cache_control": {"type": "ephemeral"}}`.
- В одном запросе — **до 4 BP**.
- Иерархия: `tools → system → messages`. Изменение в `tools` ломает кеш для всех уровней ниже.
- Платформы: полный feature-set на Anthropic API + Azure AI Foundry. Bedrock и Vertex AI поддерживают caching, но с задержками по фичам и organization-level isolation.

## 2. Lookback walk — как ищется матч

```
Текущий запрос с BP на M6:    Предыдущий кеш на M5:

  M1 M2 M3 M4 M5 M6'           M1 M2 M3 M4 M5★
                ↑BP                          ↑было закешировано

hash(M1..M6') ≠ hash(M1..M5)  ← MISS на BP
        │
        ▼  walk назад, до 20 блоков
hash(M1..M5')  → совпало? читаем кеш ★, дописываем M6'
hash(M1..M4')  → ...
...
hash(M1)       → если до сих пор нет — полный MISS, write всего

  ┌─ Окно поиска: 20 блоков назад от BP ─┐
  │ M1  M2  M3  M4  ...  M19  M20  M_BP  │
  └──────────────────────────────────────┘
        (если разговор > 20 ходов — кеш теряется)
```

- Изменение **до** BP: lookback ищет более раннюю запись (в пределах 20 блоков).
- Изменение **после** BP: вообще не кешировалось, обрабатывается заново.
- Если динамика (timestamp, ID) попадает выше BP — каждый запрос делает новый write.

## 3. Жизненный цикл одной cache entry

```
                  TTL = 5m (default) или 1h (extended)

      WRITE          READ          READ          READ           EXPIRE
        │             │             │             │                │
   ─────●─────────────●─────────────●─────────────●────────────────●─────▶ time
        │             │             │             │                │
        │  ←── 5m ──→ │  ←── 5m ──→ │  ←── 5m ──→ │  ←── 5m ──→ X  │
        │             ↑refresh      ↑refresh      ↑refresh         │
        │             │             │             │                │
   1.25× cost      0.1× cost     0.1× cost     0.1× cost      молчаливое
                                                              удаление
```

- **TTL отсчитывается от последнего READ**, не от write.
- Каждое попадание сбрасывает TTL — активная сессия держит кеш бесконечно.
- Истечение — молчаливое: ошибки нет, просто следующий запрос идёт как полный write.
- Eviction policy при заполнении пула в публичной доке не описана. Только TTL.

## 4. Стоимость и break-even

```
Стоимость в множителях base input price:

  ┌──────────────┬──────────┬──────────┬─────────┐
  │              │  no-cache │  5m TTL  │  1h TTL │
  ├──────────────┼──────────┼──────────┼─────────┤
  │ Write (1×)   │  1.00×   │  1.25×   │  2.00×  │
  │ Read (HIT)   │  1.00×   │  0.10×   │  0.10×  │
  └──────────────┴──────────┴──────────┴─────────┘

Для N запросов с одним и тем же префиксом:

  no-cache:  cost = N × 1.00
  5m cache:  cost = 1.25 + (N-1) × 0.10
  1h cache:  cost = 2.00 + (N-1) × 0.10

Кривая (5m cache):
  N=1:  1.25 ▓░░░░░░░░░  vs no-cache 1.00 — write дороже
  N=2:  1.35 ▓▓░░░░░░░░  vs no-cache 2.00 — окупился ★
  N=3:  1.45 ▓▓░░░░░░░░  vs no-cache 3.00 — экономия 52%
  N=10: 2.15 ▓▓░░░░░░░░  vs no-cache 10.0 — экономия 78%
  N=∞:                                       → 90% экономия
```

- Output tokens **не кешируются** и не подпадают под скидку.
- Break-even для 5m: уже **2-й вызов** окупает write.
- Break-even для 1h: ~3 вызова окупают экстра 0.75× (vs 5m).

## 5. Поля usage (источник UI)

```
┌─────────────────────── usage ───────────────────────┐
│                                                     │
│  input_tokens               ──▶ ТОЛЬКО после BP     │
│  cache_creation_input_tokens ──▶ записано в кеш    │
│  cache_read_input_tokens    ──▶ прочитано из кеша  │
│  output_tokens              ──▶ обычные out tokens  │
│                                                     │
│  cache_creation: {           │ разбивка write по    │
│    ephemeral_5m_input_tokens │ TTL-бакетам          │
│    ephemeral_1h_input_tokens │                      │
│  }                                                  │
└─────────────────────────────────────────────────────┘
```

**Инвариант:**
```
cache_creation_input_tokens = ephemeral_5m + ephemeral_1h
total_input_to_model = input_tokens + cache_creation + cache_read
```

`input_tokens` — это **только токены после последнего BP**, а не полный input.

## 6. Состояния кеша (decision tree для UI)

```
                  cache_read > 0 ?
                     │
            ┌────────┴────────┐
           Yes               No
            │                 │
   cache_creation > 0 ?       cache_creation > 0 ?
       │                         │
   ┌───┴───┐                 ┌───┴───┐
  Yes     No                Yes     No
   │       │                 │       │
   ▼       ▼                 ▼       ▼
  HIT+W   PURE HIT         COLD     UNDERFLOW
  ░░▓░    ▓▓▓▓             WRITE    или нет cache_control
  норма   идеал            ░░░▓     ─────
  (диалог (повтор          ░░░░     скрыть
  растёт) того же)         первый   в UI
                           ход
```

| Состояние | input | write | read | Что показывать |
|---|---|---|---|---|
| Cold WRITE | small | LARGE | 0 | `cache ↑75k` (жёлтый) |
| PURE HIT | small | 0 | LARGE | `cache ↓75k` (зелёный) |
| HIT+W | small | small | LARGE | `cache ↓75k +0.4k` (зелёный + dim жёлтый) |
| Underflow | LARGE | 0 | 0 | сегмент скрыт |
| Invalidated | LARGE | LARGE | 0 | `cache ↑75k` снова |

## 7. SSE timeline — когда узнаём про hit

```
event: message_start          ◀─── ✓ usage уже здесь!
data: {... "usage": {            cache_read/creation видны
        "input_tokens": 6,       ДО первого токена output
        "cache_creation": 0,
        "cache_read": 75644 }}

event: content_block_start
event: content_block_delta    ◀─── токены output текут
event: content_block_delta
...
event: content_block_stop

event: message_delta          ◀─── ✓ финальные числа (CUMULATIVE!)
data: {... "usage": {            ⚠ НЕ суммировать с message_start
        ...,                     ⚠ брать ПОСЛЕДНЕЕ значение
        "output_tokens": 510 }}

event: message_stop           ◀─── usage уже не приходит
```

**Грабли:** значения `usage` в `message_delta` — кумулятивные, не дельта.
Наивная сумма `message_start.usage + message_delta.usage` удваивает числа
(см. [LangChain.js #10249](https://github.com/langchain-ai/langchainjs/issues/10249)).

## 8. Что инвалидирует кеш — каскад tools→system→messages

```
Уровень изменения      │ Что слетает
───────────────────────┼─────────────────────────────────
effort level (CC)      │ ВСЁ — full history re-read на след. msg ✱
tool definitions       │ ВСЁ (tools + system + messages)
────────────────────── ├─ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
web_search/fetch toggle│ system + messages
citations toggle       │ system + messages
speed: fast/std        │ system + messages
────────────────────── ├─ ░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
tool_choice            │ только messages
disable_parallel_tools │ только messages
add/remove image       │ только messages
thinking params        │ только messages
────────────────────── └─ ░░▓▓▓▓▓▓▓▓
НЕ инвалидируют:
  temperature, top_p, top_k, max_tokens — кеш живой
  смена модели — отдельный namespace, кеш не работает,
                 но и не «теряется» (виден на старой модели)
```

✱ **Effort level (Claude Code-специфично).** Команда `/model` с
переключением effort level выводит явный диагностический warning:

> «This conversation is cached for the current effort level. Switching
> to max means the full history gets re-read on your next message.»

То есть effort level входит в cache key (вероятно через изменение
system prompt или tool selection). Подробности — в
[`prompt-caching-investigation.md`](./prompt-caching-investigation.md#cache-invalidation--наблюдаемое-поведение).

## 9. Минимальные пороги (cacheable prompt length)

| Модели | Min cacheable tokens |
|---|---|
| Mythos Preview, Opus 4.7 / 4.6 / 4.5, Haiku 4.5 | **4096** |
| Sonnet 4.6, Haiku 3.5 (deprecated) | **2048** |
| Sonnet 4.5 / 4 / 3.7, Opus 4.1 / 4 / 3, Haiku 3 | **1024** |

**Что если меньше:** молчаливое игнорирование. Запрос обрабатывается
без кеширования, ошибки нет.

**Способ детекта:** оба `cache_*_input_tokens === 0` при наличии `cache_control`
в запросе → underflow.

## 10. Claude Code конкретно

```
┌──────────────────────── CLAUDE CODE ─────────────────────────┐
│                                                              │
│  System prompt (~4k токенов: identity, instructions)         │
│   └──── shared между всеми пользователями (org cache)        │
│                                                              │
│  Tools (включая MCP) ─── stable между ходами ───┐            │
│                                                  │            │
│  CLAUDE.md / AGENTS.md / GEMINI.md ─── per project           │
│                                                  │            │
│  Conversation history ─── меняется               │            │
│   └─ <system-reminder> теги ВНУТРИ user msg,    │            │
│      чтобы не ломать system cache                │            │
│                                                  │            │
│  TTL по умолчанию: 1 hour ◀──────────────────────┘            │
│  (эмпирически в transcript на этой машине,                   │
│   ephemeral_1h_input_tokens > 0)                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Источник истины для UI:**
```
~/.claude/projects/<dir-slug>/<session-uuid>.jsonl
```

`dir-slug` — текущая директория, где `:`, `\`, `/` заменены на `-`
(например, `C:\GitHub\claude-code-statusline` → `C--GitHub-claude-code-statusline`).

Каждая запись `type: "assistant"` имеет `message.usage` с полным набором
prompt-caching полей. Парсим последнюю такую запись по `session_id` → читаем
поля.

## 11. Архитектура UI-фичи (как реализовано в `statusline.js`)

```
                    Claude Code
                         │
                         ▼
                  передаёт session_id
                  в stdin statusline
                         │
                         ▼
                  statusline.js
                  (hot path, < 100ms)
                         │
                         │  читает последние 16 KB
                         │  ~/.claude/projects/<slug>/<session>.jsonl
                         ▼
                  парсит назад по строкам,
                  ищет последний type:"assistant"
                  с непустыми cache-полями
                         │
                         ▼
                  рендерит сегмент:
                    cache ↓122k +0.4k 1h
                       │   │     │    │
                       │   │     │    └─ TTL=1h (5m скрывается)
                       │   │     └─ дописали в кеш
                       │   └─ прочитано из кеша
                       └─ префикс (dim)
```

**Дизайн-решения:**

- Источник — transcript JSONL, а не stdin: API Claude Code сейчас не
  передаёт `usage` в stdin статусной строки.
- Bridge file через `os.tmpdir()` (как для context-window) **не нужен** —
  чтение JSONL быстрое (16 KB достаточно для последних 5–10 записей,
  парсинг — микросекунды).
- TTL `5m` не отображается — это default (happy path). `1h` показывается
  явно как сигнал «кешируем надолго».
- Стрелки осмысленные и не пересекаются с git-сегментом: `↓` — токены
  пришли из кеша (экономия 90%), `↑` — токены уехали в кеш (премия 1.25×
  или 2×). `+` для incremental write при наличии read.

## Открытые вопросы (не задокументировано в публичной доке)

1. Eviction policy при заполнении пула — описан только TTL, LRU/LFU не
   упоминаются.
2. Точное поведение при concurrent write одинакового префикса — доки
   рекомендуют сериализовать.
3. Влияет ли `anthropic-beta` header на cache key — эмпирически нет, но
   не подтверждено.
4. Структура `usage.iterations[]` для tool_use циклов — публично не
   описана, но видна в transcript JSONL.
5. Поля `service_tier`, `speed`, `inference_geo` в transcript — публично
   не задокументированы.

## Итоговые таблицы

### TTL × pricing

| TTL | Write | Read | Break-even | Когда выбирать |
|---|---|---|---|---|
| 5m | 1.25× | 0.1× | 2 запроса | Активный диалог, частые ходы |
| 1h | 2× | 0.1× | ~3 запроса | Долгие документы, паузы > 5m |

### Поля × состояние кеша

| Состояние | input_tokens | cache_creation | cache_read |
|---|---|---|---|
| Cold (1-й запрос) | small | LARGE | 0 |
| Warm hit | small | 0 | LARGE |
| Hit + incremental | small | small | LARGE |
| Below min threshold | LARGE | 0 | 0 |
| Cache invalidated | LARGE | LARGE | 0 |
