# Account Switcher — плагин для Orca

Кроссплатформенный плагин для **Orca** (`>= 1.4.248`, **macOS / Windows / Linux**), который позволяет переключать аккаунты на лету с отображением квот (5h / Weekly):

- **Orca Agents**: переключение управляемых аккаунтов в самой Orca (**Antigravity**, **Claude**, **Codex**, **OpenCode**, **Devin**).
- **AGY Vault**: встроенное зашифрованное хранилище Google-аккаунтов и переключение **`agy` CLI + системного keyring + `~/.gemini/` + Orca ACP** на лету **без сторонних менеджеров** (`antigravity-tools` / `Cockpit Tools` не требуются, но при наличии `~/.antigravity_tools/accounts` автоматически подхватываются).
- **Индикатор в статус-баре**: текущий активный аккаунт и минимальная оставшаяся квота.

---

## Требования

- **Orca** версии `1.4.248` или новее (с включённым CLI `orca`).
- Для **Linux** (опционально): `secret-tool` (`libsecret-tools`), если нужен системный keyring (без него плагин автоматически работает через файловый fallback).
- Для **Windows**: стандартный PowerShell (есть в Windows 10/11) для обновления Windows Credential Manager (`gemini:antigravity`).

---

## Способ 1. Установка из GitHub (рекомендуется)

```bash
orca plugin system on
orca plugin install tonojkeee/orca-account-switcher
```

Так как плагин использует `trusted-worker` (доступ к локальным CLI, файлам `~/.gemini` и keyring), Orca выведет список прав и **fingerprint одобрения** вида `ap1-...`. Подтвердите установку:

```bash
orca plugin install tonojkeee/orca-account-switcher --approve ap1-<ваш_fingerprint>
```

Затем откройте панель **Accounts** в правой боковой панели Orca или командой:

```bash
orca plugin open tonojkeee.account-switcher
```

---

## Способ 2. Установка из локальной папки

1. Убедитесь, что Orca запущена, и откройте терминал в корне папки плагина (где лежит `orca-plugin.json`).
2. Включите систему плагинов и установите плагин:
   ```bash
   orca plugin system on
   orca plugin install .
   ```
3. Повторите команду с напечатанным `--approve ap1-...`:
   ```bash
   orca plugin install . --approve ap1-<ваш_fingerprint>
   ```
4. Откройте панель плагина:
   ```bash
   orca plugin open local.account-switcher
   ```

> **Windows (`PowerShell` / `cmd`)**: если `orca` не найден в `PATH`, вызывайте его по полному пути:
> `"%LOCALAPPDATA%\Programs\Orca\resources\bin\orca.cmd" plugin install tonojkeee/orca-account-switcher`

---

## Способ 3. Режим разработки (`dev`)

Удобен, если вы правите код плагина — Orca автоматически перезагружает его при изменениях:

```bash
orca plugin dev load .
# подтвердить права:
orca plugin dev load . --approve ap1-<ваш_fingerprint>
```

Полезные команды для проверки и отладки:
- `orca plugin list` — статус плагина (`running`).
- `orca plugin logs local.account-switcher` — логи воркера.
- `orca plugin dev unload .` — отключить dev-папку.

---

## Как добавить аккаунты без внешних менеджеров

Откройте вкладку **AGY Vault** в панели **Accounts**:

1. **+ Add Google Account** — запускает встроенный Google OAuth2 PKCE (локальный callback `127.0.0.1`).
   - Нажмите **Open in Browser** (или скопируйте URL в окно **Инкогнито**, чтобы добавить второй/третий Google-аккаунт).
   - После входа в браузере аккаунт автоматически сохранится в зашифрованное хранилище Orca (`orca.secrets`) и активируется.
   - Если браузер открыт в другом профиле/контейнере и редирект не сработал сам, вставьте итоговый URL из адресной строки в поле **Manual callback URL or code** и нажмите **Complete Sign-In**.
2. **Import Current AGY** — в 1 клик импортирует текущий активный логин `agy` CLI из системного keyring / `~/.gemini/`.

> **Важно**: чтобы кнопка **Add Google Account** знала OAuth Client ID/Secret без зашитых ключей в коде, плагин автоматически берёт их из уже инициализированного Orca Chat (`acp_token.json`), `~/.gemini/oauth_creds.json` или установленного бинарника `agy`. При необходимости их можно задать вручную в **Orca Settings → Plugins → Account Switcher**.

---

## Настройки безопасности, обновлений и квот

В **Orca Settings → Plugins → Account Switcher**:
- **Auto-refresh interval (`pollSeconds`)**: по умолчанию `0` (обновление квот **только вручную** по кнопке **Refresh** / **Best**, чтобы не создавать лишних фоновых запросов с одного IP). При включении автоопроса минимум — `600` секунд.
- **Status bar click action**: действие по клику в статус-баре (`Refresh` или `Switch to Best`).
- **Auto-switch Antigravity on low quota**: по умолчанию выключено (`false`).
- **Check for plugin updates (`checkUpdates`)**: по умолчанию включено (`true`) — раз в 6 часов проверяет свежую версию `orca-plugin.json` в GitHub; при выходе новой версии показывает системное уведомление (1 раз на версию) и баннер в панели с командой обновления:
  ```bash
  orca plugin update --all
  # для локальной dev-папки:
  git pull && orca plugin dev reload .
  ```

---

## Примечание по Windows (`agy` CLI)

При переключении аккаунта плагин обновляет:
- Windows Credential Manager (`gemini:antigravity`),
- `%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token`,
- `%USERPROFILE%\.gemini\jetski-standalone-oauth-token`,
- `%USERPROFILE%\.gemini\oauth_creds.json` и `google_accounts.json`,
- профиль Orca Chat (`acp_token.json`).

Если корпоративная политика Windows блокирует `PowerShell Add-Type` (запись в Credential Manager) и плагин вывел предупреждение об этом, выполните один раз в терминале:
```cmd
cmdkey /delete:gemini:antigravity
```
После этого `agy` будет напрямую читать обновляемый плагином файл `%USERPROFILE%\.gemini\antigravity-cli\antigravity-oauth-token`.

---

## Разработка и тесты

```bash
orca plugin validate .
orca plugin test .
orca plugin check .
```
