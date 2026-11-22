import 'package:flutter/widgets.dart';

import 'api.dart';
import 'incidents_store.dart';
import 'push.dart';
import 'realtime.dart';
import 'session.dart';

/// Доступ к сервисам приложения из любого виджета: AppScope.of(context).store.
/// Без сторонних пакетов управления состоянием: сервисы — ChangeNotifier,
/// виджеты подписываются через ListenableBuilder.
class AppScope extends InheritedWidget {
  const AppScope({
    super.key,
    required this.api,
    required this.session,
    required this.store,
    required this.realtime,
    required this.push,
    required super.child,
  });

  final ApiClient api;
  final Session session;
  final IncidentsStore store;
  final Realtime realtime;
  final PushService push;

  static AppScope of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope не найден в дереве виджетов');
    return scope!;
  }

  @override
  bool updateShouldNotify(AppScope oldWidget) => false;
}
