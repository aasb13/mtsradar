import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'config.dart';

/// WebSocket /api/ws: события в реальном времени, пока приложение открыто.
/// Сам переподключается (1, 2, 4 … 30 с). После переподключения шлёт событие `_connected`,
/// по нему список перечитывается: пропущенные за время обрыва события не повторяются.
class Realtime {
  Realtime(this.api);

  final ApiClient api;
  final ValueNotifier<bool> connected = ValueNotifier(false);
  final StreamController<Map<String, dynamic>> _events = StreamController.broadcast();

  WebSocket? _socket;
  Timer? _ping;
  Timer? _retry;
  bool _running = false;
  int _attempt = 0;

  Stream<Map<String, dynamic>> get events => _events.stream;

  void start() {
    if (_running) return;
    _running = true;
    _connect();
  }

  /// Приложение вернулось из фона — переподключаемся сразу, не дожидаясь таймера.
  void reconnectNow() {
    if (!_running || connected.value) return;
    _retry?.cancel();
    _attempt = 0;
    _connect();
  }

  Future<void> _connect() async {
    if (!_running) return;
    if (_attempt > 0) {
      // токен мог истечь: любой запрос с 401 обновит его через refresh
      try {
        await api.get('/api/me');
      } catch (_) {}
    }
    final token = api.accessToken;
    if (token == null || !_running) return;
    try {
      final socket = await WebSocket.connect(
        AppConfig.websocket(token).toString(),
      ).timeout(const Duration(seconds: 10));
      if (!_running) {
        await socket.close();
        return;
      }
      _socket = socket;
      _attempt = 0;
      connected.value = true;
      _events.add(const {'type': '_connected'});
      _ping = Timer.periodic(const Duration(seconds: 25), (_) {
        _socket?.add(jsonEncode({'type': 'ping'}));
      });
      socket.listen(
        (data) {
          if (data is! String) return;
          try {
            final msg = jsonDecode(data);
            if (msg is Map) _events.add(msg.cast<String, dynamic>());
          } catch (_) {}
        },
        onDone: _onClosed,
        onError: (Object _) => _onClosed(),
        cancelOnError: true,
      );
    } catch (_) {
      _onClosed();
    }
  }

  void _onClosed() {
    _ping?.cancel();
    _ping = null;
    _socket = null;
    connected.value = false;
    if (!_running) return;
    _attempt += 1;
    final seconds = min(30, pow(2, _attempt - 1).toInt());
    _retry?.cancel();
    _retry = Timer(Duration(seconds: seconds), _connect);
  }

  Future<void> stop() async {
    _running = false;
    _retry?.cancel();
    _ping?.cancel();
    connected.value = false;
    await _socket?.close();
    _socket = null;
  }
}
