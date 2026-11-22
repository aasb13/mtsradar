# МТС Радар — мобильное приложение (Flutter)

Только просмотр и уведомления:
- **Координатор / админ / наблюдатель** видит все текущие инциденты по уровням 4 → 1 и получает уведомления о новых инцидентах (и остальные: критический, решён, назначен на координаторов, сроки).
- **Разработчик** видит только «свои» инциденты и получает уведомление, когда его **назначили исполнителем в ITSM** (`assignedEmployeeLogin` = его `itsmLogin`) или **координатор добавил его в инцидент**.

Вход — те же логин и пароль, что на сайте. Android — основная платформа, iOS собирается из того же кода.

Как приходят уведомления:

| Состояние приложения | Канал | Что нужно |
|---|---|---|
| открыто | WebSocket `/api/ws` → баннер внизу экрана + список обновляется сам | ничего |
| свёрнуто / закрыто | push Firebase Cloud Messaging → системное уведомление, нажатие открывает инцидент | настроить Firebase (шаг 6), необязательно |

---

## Шаг 1. Установить инструменты (один раз, Windows)

1. **Git** — уже есть.
2. **Flutter SDK** — docs.flutter.dev → Get started → Windows → Android. Скачайте zip, распакуйте в `C:\src\flutter` (**не** в `Program Files`, путь без пробелов и кириллицы). Добавьте `C:\src\flutter\bin` в `Path`: Пуск → «Изменение системных переменных среды» → Переменные среды → Path → Создать.
3. **Android Studio** — developer.android.com/studio. При первом запуске мастер поставит Android SDK. Затем: More Actions → SDK Manager → вкладка SDK Tools → отметьте **Android SDK Command-line Tools** → Apply.
4. **VS Code** + расширения **Flutter** и **Dart** (или работайте прямо в Android Studio — плагин Flutter ставится из Plugins).
5. **Перезапустите VS Code целиком** (чтобы подхватился новый Path) и в терминале:
   ```powershell
   flutter doctor --android-licenses   # на все вопросы: y
   flutter doctor
   ```
   Нужны зелёные галочки у Flutter, Android toolchain, Android Studio. Пункты Chrome / Visual Studio можно игнорировать.

## Шаг 2. Эмулятор (или телефон)

- **Эмулятор:** Android Studio → More Actions → **Virtual Device Manager** → Create device → Pixel 8 → образ с пометкой **Google Play** (нужен для push) → Finish → ▶.
- **Телефон:** Настройки → О телефоне → 7 раз нажать «Номер сборки» → в «Для разработчиков» включить «Отладка по USB» → подключить кабелем → разрешить отладку.

Проверка: `flutter devices` показывает устройство.

## Шаг 3. Подготовить проект (один раз)

Папка `android/` и `ios/` генерируются Flutter-ом под вашу версию, затем скрипт вносит наши настройки:

```powershell
cd F:\Hahaton\mts-radar-mobile
flutter create --org ru.mtsradar --project-name mts_radar --platforms android,ios .
dart run tool/setup_platforms.dart
flutter pub get
```

`flutter create .` не трогает существующие файлы (код в `lib/`, `pubspec.yaml`, README), только добавляет недостающие. Скрипт `setup_platforms.dart`:
- Android: разрешения интернет и уведомления, http к локальному бэкенду, название «МТС Радар», minSdk ≥ 24;
- iOS: название, http к локальному бэкенду, фоновый режим для push.

Папки `android/` и `ios/` после этого **закоммитьте** — остальным в команде шаг 3 повторять не придётся.

## Шаг 4. Указать адрес бэкенда

```powershell
copy env.example.json env.json
```
В `env.json` поле `API_BASE_URL`:

| Где запускаете | Значение |
|---|---|
| эмулятор, бэкенд на этом же компьютере | `http://10.0.2.2:8000` (по умолчанию) |
| телефон / любой случай | https-адрес туннеля: `https://xxx.trycloudflare.com` (как для Telegram-бота) |
| телефон в той же Wi-Fi сети | `http://<IP компьютера>:8000`, а бэкенд запускать с `--host 0.0.0.0` |

`env.json` в `.gitignore` — у каждого свой.

## Шаг 5. Запуск

Бэкенд (API + воркер) должен работать. Затем:
```powershell
flutter run --dart-define-from-file=env.json
```
Во время работы: `r` — горячая перезагрузка после правки кода, `R` — полный перезапуск, `q` — выход.

Вход для проверки (после `python -m scripts.seed_users` на бэкенде, пароль `demo12345`):
- `coord1@example.com` — координатор, видит все текущие инциденты;
- `alice@example.com`, `winnie@example.com` — разработчики (`itsmLogin` alice / winnie), видят только свои.

Проверить уведомление: на бэкенде `uv run python -m scripts.demo new-critical` → у координатора баннер. Для разработчика: в `data/incidents.json` у активного инцидента поставьте `"assignedEmployeeLogin": "alice"` → у Алисы «Вас назначили на инцидент…».

Из VS Code: откройте папку проекта, внизу справа выберите устройство, F5. Чтобы F5 брал `env.json`, создайте `.vscode/launch.json`:
```json
{ "configurations": [ { "name": "МТС Радар", "request": "launch", "type": "dart",
    "args": ["--dart-define-from-file=env.json"] } ] }
```

## Шаг 6 (необязательно). Push-уведомления в фоне — Firebase

Без этого шага всё работает, просто уведомления приходят, только пока приложение открыто.

1. console.firebase.google.com → **Создать проект** (Google Analytics можно выключить).
2. **Добавить приложение → Android**. Package name: `ru.mtsradar.mts_radar` (точно так, как создан в шаге 3). Скачайте `google-services.json` — он нужен только чтобы взять из него значения (в проект его класть не нужно):

   | Поле в env.json | Где в google-services.json |
   |---|---|
   | `FIREBASE_PROJECT_ID` | `project_info.project_id` |
   | `FIREBASE_SENDER_ID` | `project_info.project_number` |
   | `FIREBASE_ANDROID_APP_ID` | `client[0].client_info.mobilesdk_app_id` |
   | `FIREBASE_API_KEY` | `client[0].api_key[0].current_key` |

3. **Бэкенд:** Firebase → ⚙ Project settings → **Service accounts** → Generate new private key. Сохраните файл в папку бэкенда как `firebase-service-account.json` (он в `.gitignore`, **не коммитьте**) и в `.env` бэкенда:
   ```
   FCM_SERVICE_ACCOUNT_FILE=firebase-service-account.json
   ```
   Перезапустите воркер.
4. Перезапустите приложение с обновлённым `env.json`, войдите, разрешите уведомления. В профиле (аватар справа вверху) должно быть «Push-уведомления: включены».
5. Сверните приложение и создайте инцидент — придёт системное уведомление.

Эмулятор для push должен быть с образом **Google Play**.

**iOS push** дополнительно требует Mac, платный Apple Developer аккаунт, APNs-ключ (Firebase → Cloud Messaging → Apple app configuration), регистрацию iOS-приложения в Firebase (`FIREBASE_IOS_APP_ID`, `FIREBASE_IOS_BUNDLE_ID`) и в Xcode: Signing & Capabilities → **Push Notifications**. Без этого iOS-версия работает без фоновых push.

## Сборка APK для показа
```powershell
flutter build apk --release --dart-define-from-file=env.json
```
Файл: `build\app\outputs\flutter-apk\app-release.apk` — можно отправить на любой Android-телефон (адрес бэкенда «зашит» в сборку, используйте https-туннель).

## Структура
```
lib/
  main.dart                 запуск, выбор экрана (вход / главный)
  core/
    config.dart             адрес бэкенда и ключи Firebase из --dart-define
    api.dart                HTTP (dart:io): JWT, автообновление токена, ошибки по-русски
    session.dart            вход/выход, восстановление сессии при запуске
    incidents_store.dart    текущие инциденты по уровням, применение событий WebSocket
    realtime.dart           WebSocket с автопереподключением
    push.dart               Firebase Cloud Messaging (если настроен)
    models.dart             карточка инцидента, пользователь, уведомление
    theme.dart              цвета макета (DF263D / DF5169 / D77B99 / D292BD), шрифт Inter
    format.dart             даты и «осталось / просрочен на»
    app_scope.dart          доступ к сервисам из виджетов
  screens/                  вход, главный (уровни), карточка инцидента, уведомления
  widgets/                  логотип, карточка, колонка уровня
tool/setup_platforms.dart   настройка android/ и ios/ после flutter create
assets/fonts/               Inter (OFL)
```

## Если не работает
| Симптом | Что делать |
|---|---|
| `flutter` не найден | не добавлен `C:\src\flutter\bin` в Path или не перезапущен VS Code |
| «Нет связи с сервером (http://10.0.2.2:8000)» | бэкенд не запущен; на телефоне 10.0.2.2 не работает — нужен туннель или IP компьютера |
| Ошибка про `minSdk` при сборке | не запущен `dart run tool/setup_platforms.dart` |
| Разработчик видит пустой список | у пользователя не задан `itsmLogin` или нет активных инцидентов с таким `assignedEmployeeLogin` |
| Нет push, в профиле «не настроены» | пустые `FIREBASE_*` в env.json или запуск без `--dart-define-from-file=env.json` |
| Push «включены», но не приходят | не задан `FCM_SERVICE_ACCOUNT_FILE` на бэкенде; эмулятор без Google Play; в логе воркера `fcm send failed` |
| Push не работает при «включены» и правильном бэкенде | запасной путь: `dart pub global activate flutterfire_cli` → `flutterfire configure` (сгенерирует нативные файлы Firebase) |
