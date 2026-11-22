import 'dart:io';

/// Настройки сборки. Передаются при запуске:
///   flutter run --dart-define=API_BASE_URL=https://xxx.trycloudflare.com
/// или все сразу из файла:
///   flutter run --dart-define-from-file=env.json
class AppConfig {
  AppConfig._();

  /// Адрес бэкенда. 10.0.2.2 — это «localhost компьютера» изнутри Android-эмулятора.
  static const String apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:8000');

  // --- Firebase (push). Пусто — push выключен, приложение работает без него. ---
  static const String firebaseApiKey = String.fromEnvironment('FIREBASE_API_KEY');
  static const String firebaseProjectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  static const String firebaseSenderId = String.fromEnvironment('FIREBASE_SENDER_ID');
  static const String firebaseAndroidAppId = String.fromEnvironment('FIREBASE_ANDROID_APP_ID');
  static const String firebaseIosAppId = String.fromEnvironment('FIREBASE_IOS_APP_ID');
  static const String firebaseIosBundleId = String.fromEnvironment('FIREBASE_IOS_BUNDLE_ID');

  static String get firebaseAppId => Platform.isIOS ? firebaseIosAppId : firebaseAndroidAppId;

  static bool get pushConfigured =>
      firebaseApiKey.isNotEmpty &&
      firebaseProjectId.isNotEmpty &&
      firebaseSenderId.isNotEmpty &&
      firebaseAppId.isNotEmpty;

  static String get _base => apiBaseUrl.endsWith('/') ? apiBaseUrl.substring(0, apiBaseUrl.length - 1) : apiBaseUrl;

  /// Ссылки из ответов бэкенда могут содержать localhost/127.0.0.1: на телефоне
  /// это сам телефон, а не компьютер с бэкендом. Подменяем хост на адрес API,
  /// сохраняя путь и query-параметры.
  static Uri resolveServerUrl(String raw) {
    final uri = Uri.parse(raw);
    final base = Uri.parse(apiBaseUrl);
    const localHosts = {'localhost', '127.0.0.1', '::1'};
    if (!localHosts.contains(uri.host)) return uri;
    return uri.replace(
      scheme: base.scheme,
      host: base.host,
      port: base.hasPort ? base.port : null,
    );
  }

  static Uri api(String path, [Map<String, String>? query]) {
    final uri = Uri.parse('$_base$path');
    return query == null || query.isEmpty ? uri : uri.replace(queryParameters: query);
  }

  static Uri websocket(String accessToken) {
    final base = Uri.parse('$_base/api/ws');
    return base.replace(scheme: base.scheme == 'https' ? 'wss' : 'ws', queryParameters: {'token': accessToken});
  }
}
