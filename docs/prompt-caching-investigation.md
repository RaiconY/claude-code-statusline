# Prompt Caching — investigation log

> Эмпирическая валидация поведения prompt cache в Claude Code, история регрессий
> 1h↔5m TTL, env-vars, и состояние на 2026-05-07. Дополнение к
> `prompt-caching.md` (там — теория и схемы; здесь — что реально происходит
> на практике).

## TL;DR

- На подписке Pro/Max в Claude Code 2.1.132 default TTL — **1 час**, без
  каких-либо env-vars.
- Это эмпирически доказано на 14 829 assistant-turns в 27 проектах:
  cliff в hit-rate ровно на 1h границе (95.5% → 0%).
- В марте 2026 был тихий downgrade default'а с 1h на 5m, починен в
  Claude Code v2.1.126.
- Доступны env-vars `ENABLE_PROMPT_CACHING_1H=1` и
  `FORCE_PROMPT_CACHING_5M=1` для явного контроля.
- На этой машине эксперимент `$env:FORCE_PROMPT_CACHING_5M='1'`
  подтвердил, что Anthropic выполняет force-5m.

## Эмпирическая валидация TTL

### Метод

Скрипт `~/.claude/tmp/validate-cache-ttl.js` прошёл по всем
`*.jsonl` в `~/.claude/projects/`, извлёк все записи `type: "assistant"`
с непустым `usage`, для каждой пары соседних turns в одном файле посчитал
разрыв во времени и сгруппировал по бакетам.

| Параметр | Значение |
|---|---|
| Проектов | 27 |
| Transcript-файлов | 499 |
| Assistant turns с usage | 14 829 |
| Пар соседних turns | 14 696 |
| Turns с `ephemeral_1h_input_tokens > 0` | 14 627 (98.6%) |
| Turns с `ephemeral_5m_input_tokens > 0` | 0 |

### Hit-rate по разрыву во времени

| Gap | HIT | MISS | HIT % |
|---|---|---|---|
| <1m | 13 041 | 315 | 97.6% |
| 1m–5m | 1 024 | 11 | 98.9% |
| **5m–15m** | **186** | **7** | **96.4%** |
| **15m–30m** | **43** | **2** | **95.6%** |
| **30m–1h** | **21** | **1** | **95.5%** |
| **1h–2h** | **0** | **13** | **0.0%** |
| **2h–6h** | **0** | **14** | **0.0%** |
| ≥6h | 2 | 16 | 11.1% |

**Доказательство 1h TTL:** граница ровно на 1 часе. В окне 5m–1h hit-rate
стабильно 95–98% — это невозможно при 5m TTL (там было бы 0%). После 1h
hit-rate резко падает до 0% — это невозможно при больших TTL.

### Long-gap HITs

252 пары имеют gap > 5 минут с последующим HIT. Распределение:

| Gap | Count |
|---|---|
| 5m–15m | 186 |
| 15m–30m | 43 |
| 30m–1h | 21 |
| ≥6h | 2 (артефакт, см. ниже) |

### Конкретное доказательство

Самое явное в одном файле: `openclaw/b7326d6c-cb82-4ef3-913b-3e5647e9c200.jsonl`:

| Line | Timestamp (UTC) | cache_read | cache_write | TTL bucket |
|---|---|---|---|---|
| 516 | 2026-04-24T14:00:54Z | 222 129 | 1 013 | 1h |
| 528 | 2026-04-24T14:41:07Z | 223 142 | 1 385 | 1h |

**Gap 40.2 минуты, HIT 223 142 токенов.** 5m TTL истёк бы за 35 минут до
этого hit'а. Невозможно при любом TTL короче 41 минуты.

Top-5 longest gaps с HIT:

```
gap=56.5m read= 89 312  vibe-coding-course
gap=54.3m read=137 966  Context-Engineering
gap=51.5m read=103 585  vibe-coding-course
gap=50.7m read=171 537  openclaw
gap=48.3m read= 51 246  personal (home)
```

### Long-gap MISSes (44 случая, gap > 5 min, write > 0)

Это первые turns в свежих сессиях или после каких-то изменений в
префиксе. Не противоречат TTL — это другой механизм инвалидации
(меняется hash префикса, не время).

### Артефакт ≥6h (2 случая HIT)

```
gap=22.8h read=39 372 write=50 048  Context-Engineering
gap=18.8h read=39 393 write=48 027  CAVEMAN-SITE-TEST
```

22 часа на одном TTL невозможно. **Объяснение: cache-pool общий между
сессиями одного проекта.** Между двумя моими turns в одной директории
проходила другая активная сессия (моя другая сессия, или CI), которая
держала кеш горячим. Подтверждает важный факт: «cache pool per workspace,
per model» — внутри workspace разные сессии греют общий кеш.

Это побочное открытие, не зафиксированное в публичной доке Anthropic,
но критическое для понимания long-running проектов.

## История 1h ↔ 5m регрессий

| Дата | Событие |
|---|---|
| до фев 2026 | Default TTL — 5 минут (исторический). [#14628](https://github.com/anthropics/claude-code/issues/14628) уже жалуется на ~3m, closed not planned. |
| фев 2026 | Claude Code тихо начал писать в **1h** TTL. Логи показывают 33+ дня подряд 100% 1h. По словам Boris Cherny — реализовано «в некоторых местах для подписчиков», не как глобальный default. |
| **6–8 мар 2026** | **Регрессия №1**: основной агент вернули на **5m**. Без анонса в release notes. |
| **9 апр 2026** | **Регрессия №2**: sub-agents переключены на 5m (100%, 17+ дней по сканированию логов). |
| 12 апр 2026 | Открыт [issue #46829](https://github.com/anthropics/claude-code/issues/46829) с анализом 119 866 API-вызовов. |
| 13 апр 2026 | The Register публикует [материал](https://www.theregister.com/2026/04/13/claude_code_cache_confusion/). |
| апр 2026 (v2.1.108) | Добавлены env-vars `ENABLE_PROMPT_CACHING_1H` и `FORCE_PROMPT_CACHING_5M`. |
| 14 апр 2026 | [#48082](https://github.com/anthropics/claude-code/issues/48082): новые env-vars не задокументированы. **Open**. |
| 16 апр 2026 | [#49139](https://github.com/anthropics/claude-code/issues/49139): `ENABLE_PROMPT_CACHING_1H` не работает — клиент шлёт `ttl: "1h"`, сервер кладёт в `ephemeral_5m`. **Closed**. |
| **v2.1.126** | Changelog: «Fixed 1-hour prompt cache TTL being silently downgraded to 5 minutes» — первое явное признание бага. |
| **2026-05-07** (сегодня) | Версия 2.1.132. Эмпирически на этой машине 1h работает по умолчанию **без env var**. |

### Issue #46829 — детали

- **Заголовок:** «Cache TTL silently regressed from 1h to 5m around early March 2026, causing quota and cost inflation»
- **Автор:** @seanGSISG (12 апр 2026)
- **Статус:** closed as not planned
- **Доказательная база:** 119 866 API-вызовов, 4 фазы (5m → 1h → переход → 5m). Февраль (1h-фаза) — 1.1% «потерь». Март (5m-фаза) — 25.9%.
- **Финансовый ущерб у автора:** Sonnet — переплата $949 (17.1%), Opus — $1581 (17.1%). Cache write tokens (5m) — $3.75–6.25/MTok, cache reads — $0.30–0.50/MTok (×12.5 разница). Любая пауза >5 мин заставляет перезаливать контекст как cache_creation.
- **Связь с квотами:** автор объясняет всплеск жалоб подписчиков на упирание в 5-часовую квоту (cross-ref на [#45756](https://github.com/anthropics/claude-code/issues/45756) «Pro Max 5x Quota Exhausted in 1.5 Hours»).
- **Позиция Anthropic** (Jarred Sumner, Boris Cherny): *«5m — true default. 1h было сделано в некоторых местах для подписчиков, не как глобальный default. Meaningful share of Claude Code's requests are one-shot calls.»*

## Env vars

### `ENABLE_PROMPT_CACHING_1H=1`

Включает 1h TTL для всех провайдеров (Anthropic API key, Bedrock, Vertex,
Azure Foundry). Старый `ENABLE_PROMPT_CACHING_1H_BEDROCK` deprecated.
До v2.1.126 переменная была сломана.

### `FORCE_PROMPT_CACHING_5M=1`

Принудительно фиксирует 5m TTL независимо от default'а. Эмпирически
проверено на этой машине: после `$env:FORCE_PROMPT_CACHING_5M='1'`
и перезапуска Claude Code первая запись в новой сессии:

```
cache ↑80k 5m
```

`cache_creation.ephemeral_5m_input_tokens = 80 000`,
`ephemeral_1h = 0`. Anthropic выполнил env var.

### Где не задокументированы

`code.claude.com` молчит про обе переменные. Issue [#48082](https://github.com/anthropics/claude-code/issues/48082) на
тему — открыт, без реакции.

### Установка на Windows

```powershell
# на одну сессию
$env:FORCE_PROMPT_CACHING_5M = '1'
claude

# постоянно (User scope)
[System.Environment]::SetEnvironmentVariable('FORCE_PROMPT_CACHING_5M', '1', 'User')

# откатить
[System.Environment]::SetEnvironmentVariable('FORCE_PROMPT_CACHING_5M', $null, 'User')
```

## Состояние на этой машине (2026-05-07)

| Параметр | Значение |
|---|---|
| Версия Claude Code | 2.1.132 |
| `ENABLE_PROMPT_CACHING_1H` | не установлен |
| `FORCE_PROMPT_CACHING_5M` | не установлен |
| `~/.claude/settings.json` `env` | `ENABLE_TOOL_SEARCH=auto:7`, `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` |
| Доля turns с 1h TTL за всю историю | 98.6% (14 627 / 14 829) |
| Доля turns с 1h TTL в текущей сессии | 100% (162 / 162) |
| Тип авторизации | подписка (OAuth) |

**Вывод:** Anthropic вернул 1h как фактический default для подписки после
fix v2.1.126, не объявив этого. Публичная позиция «5m — true default»
расходится с тем, что Claude Code реально шлёт в API.

## Cache pool — общий между сессиями workspace

Доказано через 2 артефакта в bucket'е ≥6h: HIT после 22.8h и 18.8h
gap'а внутри одной сессии. На одном TTL это невозможно. Объяснение:
параллельные сессии в том же workspace грели кеш постоянно, и last-touch
рефрешился каждый раз, продлевая TTL.

В публичной доке этого нет. Только описано «cache pool per workspace,
per model», но не специально подчёркнуто, что **разные сессии греют
общий кеш**.

## Поведение статусной строки

### Countdown в idle — решено через `refreshInterval`

Сегмент `cache ↓X +Y 1h:Zm` использует `Date.now() - last_touch_ts`
для расчёта remaining. Statusline это short-lived процесс. По умолчанию
он вызывается только на event-driven обновлениях: новое assistant-
сообщение, `/compact`, смена permission mode, переключение vim mode
(debounce 300ms, in-flight cancellation при следующем событии).

Без таймера сценарий «вернулся после 53 минут паузы, увидел `1h:7m
yellow`» не работал: на экране оставалось `1h:60m` от последнего
refresh'а 53-минутной давности. После нажатия Enter новый ход обновлял
кеш, countdown сбрасывался на 60m, момент `7m` так и не появлялся.

**Решение — поле `statusLine.refreshInterval` в `~/.claude/settings.json`.**
Доступно с Claude Code v2.1.97 (у нас 2.1.132). Значение в секундах,
минимум 1, дополняется к event-driven обновлениям. Цитата из
[документации](https://code.claude.com/docs/en/statusline):

> «The optional `refreshInterval` field re-runs your command every N
> seconds in addition to the event-driven updates. The minimum is `1`.
> Set this when your status line shows time-based data such as a clock,
> or when background subagents change git state while the main session
> is idle.»

Рекомендация для этого statusline — **`refreshInterval: 60`**. Раз в
минуту достаточно, чтобы countdown переходил через цветовые границы
плавно (dim → yellow → red), и при этом нагрузка минимальна — мы читаем
только последние 16 KB транскрипта.

Установка:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:/Users/you/.claude/hooks/statusline.js\"",
    "refreshInterval": 60
  }
}
```

Без этого поля countdown в idle «застывает» — это документированное
ограничение, не баг кода statusline.

## Cache invalidation — наблюдаемое поведение

### Effort level switch — full prefix re-read

Claude Code показывает явный warning при смене effort level через
команду `/model`:

> «This conversation is cached for the current effort level. Switching
> to max means the full history gets re-read on your next message.»

Это означает, что **effort level входит в hash префикса** (или
вызывает изменение system prompt / tool selection, что для cache
key эквивалентно). Любое переключение → полная инвалидация
текущего кеша → следующее сообщение оплачивается как cache_creation
(write 1.25× или 2×) на всю накопленную историю.

Импликации:
- На длинной сессии (100k+ токенов) одно переключение effort
  стоит ≈ 1.25× × N токенов write (или 2× при 1h TTL).
- Кеш для нового effort строится с нуля. Не проверено, остаётся ли
  старый кеш «жить» в пуле и подхватывается ли при возврате к
  прежнему effort до истечения TTL.
- В UI это видно как: после переключения первое assistant-сообщение
  даёт `cache ↑XXk` (write) вместо обычного `cache ↓XXk +0.5k` (read).

Источник: in-app diagnostic message при `/model` → выбор нового
effort level (скриншот зафиксирован 2026-05-07).

В каскаде инвалидации `prompt-caching.md` раздел 8 — это самый верхний
уровень, наряду с изменением tool definitions. Эффективно работает
как «новая сессия с тем же транскриптом».

## Открытые вопросы

1. **Eviction policy** при заполнении пула — описан только TTL, LRU/LFU
   не упоминаются.
2. **Concurrent write одинакового префикса** — доки рекомендуют
   сериализовать, точная семантика не описана.
3. **Влияет ли `anthropic-beta` header на cache key** — эмпирически нет,
   но не подтверждено.
4. **Структура `usage.iterations[]`** для tool_use циклов — публично не
   описана, видна только в transcript JSONL.
5. **Поля `service_tier`, `speed`, `inference_geo`** в transcript —
   публично не задокументированы.
6. **1h TTL на подписке как реальный default** — Anthropic официально
   говорит «true default 5m», эмпирика на этой машине говорит 1h. Что
   именно решает (тип подписки, регион, версия Claude Code, A/B-тест) —
   неизвестно.

## Скрипты для воспроизведения

В `~/.claude/tmp/`:
- `validate-cache-ttl.js` — агрегирует hit-rate по gap-bucket'ам
  по всем transcript'ам.
- `find-evidence-line.js` — находит конкретные строки в transcript'ах
  с самыми сильными доказательствами.

Оба запускаются `node <file>`. Не зависят от внешних пакетов.

## Источники

### Официальные

- [Prompt caching — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Tool use with prompt caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)
- [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Messages API reference](https://platform.claude.com/docs/en/api/messages)
- [Claude Code CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md)
- [Anthropic Prompt Caching announcement (Aug 2024)](https://claude.com/blog/prompt-caching)
- [April 23 2026 postmortem](https://www.anthropic.com/engineering/april-23-postmortem)

### GitHub issues

- [#46829 — TTL regression 1h→5m](https://github.com/anthropics/claude-code/issues/46829)
- [#14628 — TTL ~5→3 min (Dec 2025)](https://github.com/anthropics/claude-code/issues/14628)
- [#48082 — Docs gap для ENABLE_PROMPT_CACHING_1H](https://github.com/anthropics/claude-code/issues/48082)
- [#49139 — ENABLE_PROMPT_CACHING_1H not working](https://github.com/anthropics/claude-code/issues/49139)
- [#45756 — Pro Max 5x Quota Exhausted in 1.5 Hours](https://github.com/anthropics/claude-code/issues/45756)
- [#34629 — `--print --resume` cache regression](https://github.com/anthropics/claude-code/issues/34629)
- [LangChain.js #10249 — double-counting в стриминге](https://github.com/langchain-ai/langchainjs/issues/10249)

### Пресса и комьюнити

- [The Register — Anthropic: Claude quota drain](https://www.theregister.com/2026/04/13/claude_code_cache_confusion/)
- [XDA — Anthropic quietly nerfed Claude Code's 1-hour cache](https://www.xda-developers.com/anthropic-quietly-nerfed-claude-code-hour-cache-token-budget/)
- [dev.to/recca0120 — 17 days of 5m sub-agent TTL](https://dev.to/recca0120/12-more-days-scanned-claude-code-sub-agent-cache-ttl-has-been-100-5m-for-17-straight-days-this-7ff)
- [dev.to/recca0120 — 95-day audit, second silent regression](https://dev.to/recca0120/verify-whether-your-claude-code-uses-5m-or-1h-cache-ttl-with-60-lines-of-python-4548)
- [dev.to/whoffagents — Cache TTL silently dropped 1h → 5m](https://dev.to/whoffagents/claudes-prompt-cache-ttl-silently-dropped-from-1-hour-to-5-minutes-heres-what-to-do-13co)
- [dev.to/gabrielanhaia — Cache TTL Dropped From 1h to 5m](https://dev.to/gabrielanhaia/claude-codes-prompt-cache-ttl-dropped-from-1h-to-5m-35g)
- [thepixelspulse — Anthropic Cache TTL Downgrade on March 6th](https://thepixelspulse.com/posts/anthropic-cache-ttl-downgrade-developer-costs/)
- [cnighswonger/claude-code-cache-fix — workaround tool](https://github.com/cnighswonger/claude-code-cache-fix)

### Прайсинг и аудиты

- [Anthropic API Pricing 2026 — Finout](https://www.finout.io/blog/anthropic-api-pricing)
- [Prompt Caching 2026 cost guide — AI Checker Hub](https://aicheckerhub.com/anthropic-prompt-caching-2026-cost-latency-guide)
- [Claude Code prompt caching deep-dive — claudecodecamp](https://www.claudecodecamp.com/p/how-prompt-caching-actually-works-in-claude-code)
