import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'models.dart';

enum SessionState { loading, loggedOut, loggedIn }

/// Кто вошёл в приложение. Вход — по тем же логину и паролю, что и на сайте.
class Session extends ChangeNotifier {
  Session(this.api) {
    api.onSessionExpired = _expired;
  }

  final ApiClient api;
  SessionState state = SessionState.loading;
  AppUser? user;

  /// Запуск приложения: есть сохранённые токены — пробуем войти без формы.
  Future<void> restore() async {
    await api.loadTokens();
    if (!api.hasTokens) {
      _set(SessionState.loggedOut);
      return;
    }
    try {
      user = AppUser.fromJson((await api.get('/api/me') as Map).cast<String, dynamic>());
      await api.writeCachedUser(jsonEncode(user!.toJson()));
      _set(SessionState.loggedIn);
    } on ApiException catch (e) {
      if (e.isNetwork) {
        // сервер недоступен — открываем приложение с последним известным профилем
        final cached = await api.readCachedUser();
        if (cached != null) {
          user = AppUser.fromJson((jsonDecode(cached) as Map).cast<String, dynamic>());
          _set(SessionState.loggedIn);
          return;
        }
      }
      await api.clearTokens();
      _set(SessionState.loggedOut);
    }
  }

  Future<void> login(String email, String password) async {
    final json = await api.login(email, password);
    user = AppUser.fromJson(json);
    await api.writeCachedUser(jsonEncode(user!.toJson()));
    _set(SessionState.loggedIn);
  }

  Future<void> logout() async {
    await api.logout();
    await api.deleteCachedUser();
    user = null;
    _set(SessionState.loggedOut);
  }

  void _expired() {
    if (state != SessionState.loggedIn) return;
    user = null;
    api.deleteCachedUser();
    _set(SessionState.loggedOut);
  }

  void _set(SessionState s) {
    state = s;
    notifyListeners();
  }
}
