import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import 'api.dart';
import 'config.dart';

/// Push-уведомления через Firebase Cloud Messaging.
///
/// Работает, только если при сборке переданы ключи Firebase (см. README, env.example.json).
/// Без них приложение работает как обычно, уведомления приходят по WebSocket, пока оно открыто.
///
/// Когда приложение свёрнуто или закрыто, уведомление показывает сама система.
/// Нажатие на него открывает приложение на нужном инциденте (stream [opened]).
class PushService {
  PushService(this.api);

  final ApiClient api;
  bool enabled = false;
  String? _token;

  final StreamController<String> _opened = StreamController.broadcast();
  final StreamController<RemoteMessage> _foreground = StreamController.broadcast();

  /// Нажали на системное уведомление -> id инцидента.
  Stream<String> get opened => _opened.stream;

  /// Push пришёл, пока приложение открыто (система его в этом случае не показывает).
  Stream<RemoteMessage> get foreground => _foreground.stream;

  /// Инцидент из уведомления, по которому приложение было запущено с нуля.
  String? initialIncidentId;

  Future<void> init() async {
    if (!AppConfig.pushConfigured) {
      debugPrint('Push выключен: не заданы FIREBASE_* при сборке');
      return;
    }
    try {
      await Firebase.initializeApp(
        options: FirebaseOptions(
          apiKey: AppConfig.firebaseApiKey,
          appId: AppConfig.firebaseAppId,
          messagingSenderId: AppConfig.firebaseSenderId,
          projectId: AppConfig.firebaseProjectId,
          iosBundleId: AppConfig.firebaseIosBundleId.isEmpty ? null : AppConfig.firebaseIosBundleId,
        ),
      );
      enabled = true;
    } catch (e) {
      debugPrint('Firebase не инициализирован: $e');
      return;
    }
    final messaging = FirebaseMessaging.instance;
    FirebaseMessaging.onMessage.listen(_foreground.add);
    FirebaseMessaging.onMessageOpenedApp.listen((m) {
      final id = m.data['incidentId'];
      if (id is String && id.isNotEmpty) _opened.add(id);
    });
    final initial = await messaging.getInitialMessage();
    final initialId = initial?.data['incidentId'];
    if (initialId is String && initialId.isNotEmpty) initialIncidentId = initialId;
    messaging.onTokenRefresh.listen((token) {
      _token = token;
      _register();
    });
  }

  /// После входа: спросить разрешение на уведомления и сообщить бэкенду токен устройства.
  Future<void> registerForCurrentUser() async {
    if (!enabled) return;
    try {
      final messaging = FirebaseMessaging.instance;
      final settings = await messaging.requestPermission(alert: true, badge: true, sound: true);
      if (settings.authorizationStatus == AuthorizationStatus.denied) return;
      // iOS: показывать уведомления и при открытом приложении
      await messaging.setForegroundNotificationPresentationOptions(alert: true, badge: true, sound: true);
      _token = await messaging.getToken();
      await _register();
    } catch (e) {
      // iOS без настроенного APNs, нет Google Play Services и т.п.
      debugPrint('Push-токен не получен: $e');
    }
  }

  Future<void> _register() async {
    final token = _token;
    if (token == null || !api.hasTokens) return;
    try {
      await api.post('/api/devices', {'token': token, 'platform': Platform.isIOS ? 'ios' : 'android'});
    } on ApiException catch (e) {
      debugPrint('Не удалось зарегистрировать устройство: $e');
    }
  }

  /// Перед выходом: чтобы уведомления этого пользователя больше не приходили на телефон.
  Future<void> unregister() async {
    final token = _token;
    if (!enabled || token == null) return;
    try {
      await api.post('/api/devices/unregister', {'token': token});
    } catch (_) {}
  }
}
