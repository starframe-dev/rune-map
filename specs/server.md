# rune-map → In-Memory State Server

## Контекст

Текущий `rune-map` — извлекал пространственную карту из Three.js сцены и рендерил её в SVG. Эта задача больше не актуальна.

Новая концепция: `rune-map` — **in-memory мульти-тенант state-сервер** для AI-инструментов управления игровыми сущностями (игроками и не только).

Сценарий использования:
- **game-процесс** (далее — `source`) пушит состояние сущностей в namespace
- **AI-агент** (далее — `controller`) читает состояние, подписывается на изменения, отправляет команды управления (input-эмуляция: клики, клавиши)
- сервер — relay с in-memory хранилищем, без БД

Универсальный: один сервер обслуживает любые проекты/игры; namespace (slug) определяет изоляцию данных. Схема namespace не фиксирована — она формируется по факту первыми записанными данными.

## Цель

Превратить `rune-map` в работающий сервер, который:
1. принимает WebSocket-клиентов двух ролей (`source`, `controller`) на одном или разных namespace
2. хранит сущности (`entities`) namespace-а в памяти
3. принимает команды от `controller`, транслирует их `source`-у
4. рассылает подписчикам дельту при изменениях

Без персистентности. Без авторизации. Без внешних БД.

## Что изменилось

**Удалено:**
1. `src/core/svg-renderer.ts` — больше не нужен
2. `src/core/rune-map.ts` — заменён на хранилище
3. `specs/format.md` — заменён этим документом
4. зависимости `three`, `@types/three` из `package.json`

**Переписано:**
1. `src/core/types.ts` — новые типы (Entity, Command, Message, Role)
2. `src/core/store.ts` — `NamespaceStore` + логика бродкаста
3. `src/core/index.ts` — экспорт публичного API
4. `src/server/index.ts` — WebSocket сервер с multi-namespace
5. `src/client/index.ts` — CLI с тремя subcommands (`server`, `source`, `controller`)
6. `tsconfig.json` — `module` / `moduleResolution` изменены на `NodeNext` для рабочего ESM в Node

**Добавлено:**
1. `tests/integration.test.ts` — 6 интеграционных тестов
2. `tests/smoke.test.ts` — sanity test ws
3. `vitest.config.ts` — конфигурация vitest

## Детали реализации

### 1. Модель данных

```ts
// Любая JSON-сериализуемая сущность с обязательным строковым id
type Entity = { id: string; [key: string]: unknown }

// Команда управления
type Command = {
    id: string                                   // генерируется сервером
    kind: 'one-shot' | 'active'                  // fire-and-forget или sticky
    target?: string                              // опционально — id сущности
    payload: Record<string, unknown>             // произвольный payload
    issuedAt: string                             // ISO 8601
}
```

Сообщения протокола и ответы сервера описаны в `src/core/types.ts`.

### 2. Хранилище — `src/core/store.ts`

Класс `NamespaceStore`:
- хранит `Map<namespace, NamespaceState>` в памяти
- методы чистые, без зависимостей от WebSocket — отделены от транспорта
- методы:
  - `register(namespace, role, sink)` — регистрация клиента
  - `unregister(sink)` — снятие регистрации
  - `putEntities`, `patchEntities`, `deleteEntities`, `listEntities`, `getEntities`, `snapshot`
  - `issueCommand`, `clearCommand`
  - `subscribe`, `unsubscribe`
- broadcast отправляется асинхронно; ошибки отдельных sink-ов не пробрасываются
- sink — абстракция `MessageSink { send(message), close() }`, позволяющая тестировать store без реального WebSocket

### 3. Сервер — `src/server/index.ts`

Класс `StateServer` — обёртка над `WebSocketServer` + `NamespaceStore`:
- фабрика `create({ port?: number, slug?: string })` — auto-port, опционально пишет порт в `/tmp/{slug}.rune.port`
- маршрутизация сообщений из `types.ts`
- формирование ответных сообщений
- `sinkCache: WeakMap<WebSocket, MessageSink>` — один sink на одно соединение, чтобы подписки `NamespaceStore` работали по ссылке
- graceful source takeover: новый source вытесняет старого

### 4. CLI — `src/client/index.ts`

Бинарь `rune-map`:
- `server --namespace <slug>` — запуск сервера на автопорту, пишет порт в `/tmp/{slug}.rune.port`
- `source --namespace <slug>` — читает stdin построчно (JSON-сообщения `put`/`patch`/`delete`), либо `--input <file>`
- `controller --namespace <slug>`:
  - по умолчанию: выводит snapshot и завершается
  - `--watch` / `-w`: подписка на дельты
  - `--interactive` / `-i`: REPL с командами `send`, `hold`, `clear`, `list`, `snapshot`, `subscribe`/`unsubscribe`, `quit`
- high-level controller-only команды текущего browser source:
  - `sessions --slug <slug>` — обнаружение app-generated session names
  - `scene --slug <slug> -s <sessionName> [--pretty|--summary|--jsonl|--object <id-or-name>]`
  - `watch --slug <slug> -s <sessionName>`
  - `move --slug <slug> -s <sessionName> --x <number> --z <number> [--wait]`
  - `toggle-rune --slug <slug> -s <sessionName>`
  - `camera-reset --slug <slug> -s <sessionName>`
  - `repl --slug <slug> -s <sessionName>`
- приложение генерирует `sessionName` при создании локального игрока
- high-level CLI требует `-s/--session` и вычисляет namespace `<slug>:<sessionName>`
- high-level команды никогда не запускают браузер и не регистрируются как `source`; новый source в namespace запрещён, потому что он вытесняет текущий источник
- `--url <ws://...>` или `--slug <slug>` для поиска порта; если `--slug` не указан, используется `--namespace`

### 5. Зависимости (`package.json`)

- `dependencies`: `ws`
- `devDependencies`: `typescript`, `@types/ws`, `@types/node`, `vitest`

### 6. Публичное API

`src/core/index.ts` экспортирует:
```ts
export type { Entity, Command, CommandKind, EntityPatch, Topic, Role, ClientMessage, ServerMessage, ErrorCode, PutResult, DeleteResult, PatchResult, MessageSink, NamespaceState }
export class NamespaceStore
```

`src/server/index.ts` экспортирует:
```ts
export class StateServer
export function statePath(slug: string): string
```

## Критерии приёмки

- [x] `pnpm build` собирается без ошибок и предупреждений TypeScript
- [x] В `package.json` нет `three` и `@types/three`
- [x] `rune-map server --namespace demo` запускается, занимает свободный порт, пишет `/tmp/demo.rune.port`
- [x] `rune-map controller --namespace demo` получает snapshot
- [x] `rune-map source --namespace demo` принимает из stdin JSON-строки `{"type":"put","entities":[{"id":"p1","hp":100,"name":"Alice"}]}`
- [x] После `put` controller-подписчик получает сообщение `{type:"change", added:[{id:"p1",...}]}`
- [x] `patch` приводит к `change.updated` с `id=p1`
- [x] `delete` приводит к `change.removed:["p1"]`
- [x] `command` с `kind="one-shot"` транслируется `source`-у
- [x] `command` с `kind="active"` сохраняется в `activeCommands`; `clearCommand` удаляет
- [x] Два namespace-а полностью изолированы
- [x] `rune-map controller --interactive` принимает REPL-команды
- [x] high-level `scene` читает entity `scene` без запуска source
- [x] high-level `move`, `toggle-rune`, `camera-reset` отправляют команды текущему source
- [x] `ControllerClient` не вытесняет source; его поведение покрыто интеграционным тестом
- [x] Все интеграционные тесты + smoke test проходят через `pnpm test`
