import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'config.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.status});

  final String message;
  final int? status;

  bool get isUnauthorized => status == 401;
  bool get isNetwork => status == null;

  @override
  String toString() => message;
}

/// HTTP-клиент бэкенда на dart:io.
///
/// * access-токен живёт 30 минут: при 401 клиент один раз обновляет пару через
///   /api/auth/refresh и повторяет запрос;
/// * токены и профиль хранятся в защищённом хранилище (Keystore / Keychain);
/// * текст ошибок — по-русски, его можно показывать пользователю как есть.
class ApiClient {
  ApiClient() {
    _http.connectionTimeout = const Duration(seconds: 10);
  }

  final HttpClient _http = HttpClient();
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  String? _access;
  String? _refresh;
  Future<bool>? _refreshing;

  /// Вызывается, когда сессию восстановить нельзя (refresh отозван или истёк).
  void Function()? onSessionExpired;

  String? get accessToken => _access;
  bool get hasTokens => _refresh != null;

  Future<void> loadTokens() async {
    _access = await _storage.read(key: 'access');
    _refresh = await _storage.read(key: 'refresh');
  }

  Future<void> _saveTokens(Map<String, dynamic> pair) async {
    _access = pair['accessToken'] as String?;
    _refresh = pair['refreshToken'] as String?;
    await _storage.write(key: 'access', value: _access);
    await _storage.write(key: 'refresh', value: _refresh);
  }

  Future<void> clearTokens() async {
    _access = null;
    _refresh = null;
    await _storage.delete(key: 'access');
    await _storage.delete(key: 'refresh');
  }

  Future<String?> readCachedUser() => _storage.read(key: 'user');

  Future<void> writeCachedUser(String json) => _storage.write(key: 'user', value: json);

  Future<void> deleteCachedUser() => _storage.delete(key: 'user');

  // ---------------- публичные методы ----------------

  Future<Map<String, dynamic>> login(String email, String password) async {
    final pair =
        await _send('POST', '/api/auth/login', body: {'email': email.trim(), 'password': password}, auth: false)
            as Map<String, dynamic>;
    await _saveTokens(pair);
    return (pair['user'] as Map).cast<String, dynamic>();
  }

  Future<void> logout() async {
    final refresh = _refresh;
    if (refresh != null) {
      try {
        await _send('POST', '/api/auth/logout', body: {'refreshToken': refresh}, auth: false);
      } catch (_) {
        // выходим локально в любом случае
      }
    }
    await clearTokens();
  }

  Future<dynamic> get(String path, {Map<String, String>? query}) => _send('GET', path, query: query);

  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body: body);

  // ---------------- внутреннее ----------------

  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
    bool auth = true,
    bool retry = true,
  }) async {
    final uri = AppConfig.api(path, query);
    late int status;
    late String text;
    try {
      final req = await _http.openUrl(method, uri).timeout(const Duration(seconds: 15));
      req.headers.set(HttpHeaders.acceptHeader, 'application/json');
      if (auth && _access != null) {
        req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $_access');
      }
      if (body != null) {
        final bytes = utf8.encode(jsonEncode(body)); // write() по умолчанию latin1 — кириллица сломается
        req.headers.contentType = ContentType.json;
        req.contentLength = bytes.length;
        req.add(bytes);
      }
      final res = await req.close().timeout(const Duration(seconds: 20));
      status = res.statusCode;
      text = await res.transform(utf8.decoder).join();
    } on TimeoutException {
      throw ApiException('Сервер не отвечает (${AppConfig.apiBaseUrl})');
    } on HandshakeException {
      throw ApiException('Ошибка HTTPS-соединения с ${AppConfig.apiBaseUrl}');
    } on SocketException {
      throw ApiException('Нет связи с сервером (${AppConfig.apiBaseUrl})');
    } on HttpException {
      throw ApiException('Соединение с сервером прервано');
    }

    if (status == 401 && auth && retry && _refresh != null) {
      if (await _refreshTokens()) {
        return _send(method, path, query: query, body: body, auth: auth, retry: false);
      }
      await clearTokens();
      onSessionExpired?.call();
      throw ApiException('Сессия истекла, войдите снова', status: 401);
    }
    if (status >= 400) {
      throw ApiException(_errorText(status, text), status: status);
    }
    if (text.isEmpty) return null;
    return jsonDecode(text);
  }

  /// Несколько запросов могут одновременно получить 401 — обновляем токен один раз.
  Future<bool> _refreshTokens() {
    return _refreshing ??= () async {
      try {
        final pair =
            await _send('POST', '/api/auth/refresh', body: {'refreshToken': _refresh}, auth: false, retry: false)
                as Map<String, dynamic>;
        await _saveTokens(pair);
        return true;
      } on ApiException catch (e) {
        return e.isNetwork ? true : false; // сеть пропала — сессию не сбрасываем
      } finally {
        _refreshing = null;
      }
    }();
  }

  static String _errorText(int status, String body) {
    try {
      final detail = (jsonDecode(body) as Map)['detail'];
      if (detail is String) return detail;
      if (detail is List && detail.isNotEmpty) {
        final first = detail.first;
        if (first is Map && first['msg'] != null) return first['msg'].toString();
      }
    } catch (_) {}
    return switch (status) {
      403 => 'Недостаточно прав',
      404 => 'Не найдено',
      429 => 'Слишком много попыток, подождите минуту',
      >= 500 => 'Ошибка сервера ($status)',
      _ => 'Ошибка запроса ($status)',
    };
  }
}
